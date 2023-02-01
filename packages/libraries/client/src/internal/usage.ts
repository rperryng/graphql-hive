import {
  ArgumentNode,
  DocumentNode,
  ExecutionArgs,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLInterfaceType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
  GraphQLType,
  GraphQLUnionType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
  Kind,
  ObjectFieldNode,
  OperationDefinitionNode,
  TypeInfo,
  visit,
  visitWithTypeInfo,
} from 'graphql';
import LRU from 'tiny-lru';
import { normalizeOperation } from '@graphql-hive/core';
import { version } from '../version.js';
import { createAgent } from './agent.js';
import { randomSampling } from './sampling.js';
import type {
  ClientInfo,
  CollectUsageCallback,
  HivePluginOptions,
  HiveUsagePluginOptions,
} from './types.js';
import {
  cache,
  cacheDocumentKey,
  isAsyncIterableIterator,
  logIf,
  measureDuration,
  memo,
} from './utils.js';

interface UsageCollector {
  collect(args: ExecutionArgs): CollectUsageCallback;
  dispose(): Promise<void>;
}

export function createUsage(pluginOptions: HivePluginOptions): UsageCollector {
  if (!pluginOptions.usage || pluginOptions.enabled === false) {
    return {
      collect() {
        return () => {};
      },
      async dispose() {},
    };
  }

  let report: Report = {
    size: 0,
    map: {},
    operations: [],
  };
  const options =
    typeof pluginOptions.usage === 'boolean' ? ({} as HiveUsagePluginOptions) : pluginOptions.usage;
  const selfHostingOptions = pluginOptions.selfHosting;
  const logger = pluginOptions.agent?.logger ?? console;
  const collector = memo(createCollector, arg => arg.schema);
  const excludeSet = new Set(options.exclude ?? []);
  const agent = createAgent<CollectedOperation>(
    {
      logger,
      ...(pluginOptions.agent ?? {
        maxSize: 1500,
      }),
      endpoint:
        selfHostingOptions?.usageEndpoint ??
        options.endpoint ??
        'https://app.graphql-hive.com/usage',
      token: pluginOptions.token,
      enabled: pluginOptions.enabled,
      debug: pluginOptions.debug,
    },
    {
      prefix: 'usage',
      data: {
        set(operation) {
          report.operations.push({
            operationMapKey: operation.key,
            timestamp: operation.timestamp,
            execution: {
              ok: operation.execution.ok,
              duration: operation.execution.duration,
              errorsTotal: operation.execution.errorsTotal,
              errors: operation.execution.errors,
            },
            metadata: {
              client: operation.client,
            },
          });

          report.size += 1;

          if (!report.map[operation.key]) {
            report.map[operation.key] = {
              operation: operation.operation,
              operationName: operation.operationName,
              fields: operation.fields,
            };
          }
        },
        size() {
          return report.size;
        },
        clear() {
          report = {
            size: 0,
            map: {},
            operations: [],
          };
        },
      },
      headers() {
        return {
          'Content-Type': 'application/json',
          'graphql-client-name': 'Hive Client',
          'graphql-client-version': version,
        };
      },
      body() {
        return JSON.stringify(report);
      },
    },
  );

  logIf(
    typeof pluginOptions.token !== 'string' || pluginOptions.token.length === 0,
    '[hive][usage] token is missing',
    logger.error,
  );

  const shouldInclude = randomSampling(options.sampleRate ?? 1.0);

  return {
    dispose: agent.dispose,
    collect(args) {
      const finish = measureDuration();

      return function complete(result) {
        try {
          if (isAsyncIterableIterator(result)) {
            logger.info('@stream @defer is not supported');
            finish();
            return;
          }

          const rootOperation = args.document.definitions.find(
            o => o.kind === Kind.OPERATION_DEFINITION,
          ) as OperationDefinitionNode;
          const document = args.document;
          const operationName = args.operationName || rootOperation.name?.value || 'anonymous';
          const duration = finish();

          if (!excludeSet.has(operationName) && shouldInclude()) {
            const errors =
              result.errors?.map(error => ({
                message: error.message,
                path: error.path?.join('.'),
              })) ?? [];
            const collect = collector({
              schema: args.schema,
              max: options.max ?? 1000,
              ttl: options.ttl,
              processVariables: options.processVariables ?? false,
            });
            const { key, value: info } = collect(document, args.variableValues ?? null);

            agent.capture({
              key,
              timestamp: Date.now(),
              operationName,
              operation: info.document,
              fields: info.fields,
              execution: {
                ok: errors.length === 0,
                duration,
                errorsTotal: errors.length,
                errors,
              },
              // TODO: operationHash is ready to accept hashes of persisted operations
              client:
                typeof args.contextValue !== 'undefined' &&
                typeof options.clientInfo !== 'undefined'
                  ? options.clientInfo(args.contextValue)
                  : null,
            });
          }
        } catch (error) {
          logger.error(`Failed to collect operation`, error);
        }
      };
    },
  };
}

interface CacheResult {
  document: string;
  fields: string[];
}

export function createCollector({
  schema,
  max,
  ttl,
  processVariables = false,
}: {
  schema: GraphQLSchema;
  max?: number;
  ttl?: number;
  processVariables?: boolean;
}) {
  const typeInfo = new TypeInfo(schema);

  function collect(
    doc: DocumentNode,
    variables: {
      [key: string]: unknown;
    } | null,
  ): CacheResult {
    const entries = new Set<string>();
    const collected_entire_named_types = new Set<string>();
    const shouldAnalyzeVariableValues = processVariables === true && variables !== null;

    function markAsUsed(id: string) {
      if (!entries.has(id)) {
        entries.add(id);
      }
    }

    function makeId(...names: string[]): string {
      return names.join('.');
    }

    const collectedInputTypes: Record<
      string,
      {
        all: boolean;
        fields: Set<string>;
      }
    > = {};

    function collectInputType(inputType: string, fieldName?: string) {
      if (!collectedInputTypes[inputType]) {
        collectedInputTypes[inputType] = {
          all: false,
          fields: new Set<string>(),
        };
      }

      if (fieldName) {
        collectedInputTypes[inputType].fields.add(fieldName);
      } else {
        collectedInputTypes[inputType].all = true;
      }
    }

    function collectNode(node: ObjectFieldNode | ArgumentNode) {
      const inputType = typeInfo.getInputType()!;
      const inputTypeName = resolveTypeName(inputType);

      if (node.value.kind === Kind.ENUM) {
        // Collect only a specific enum value
        collectInputType(inputTypeName, node.value.value);
      } else if (node.value.kind !== Kind.OBJECT && node.value.kind !== Kind.LIST) {
        // When processing of variables is enabled,
        // we want to skip collecting full input types of variables
        // and only collect specific fields.
        // That's why the following condition is added.
        // Otherwise we would mark entire input types as used, and not granular fields.
        if (node.value.kind === Kind.VARIABLE && shouldAnalyzeVariableValues) {
          return;
        }

        collectInputType(inputTypeName);
      }
    }

    function markEntireTypeAsUsed(type: GraphQLInputType): void {
      const namedType = unwrapType(type);

      if (collected_entire_named_types.has(namedType.name)) {
        // No need to mark this type as used again
        return;
      }
      // Add this type to the set of types that have been marked as used
      // to avoid infinite loops
      collected_entire_named_types.add(namedType.name);

      if (isScalarType(namedType)) {
        markAsUsed(makeId(namedType.name));
        return;
      }

      if (isEnumType(namedType)) {
        namedType.getValues().forEach(value => {
          markAsUsed(makeId(namedType.name, value.name));
        });
        return;
      }

      const fieldsMap = namedType.getFields();

      for (const fieldName in fieldsMap) {
        const field = fieldsMap[fieldName];

        markAsUsed(makeId(namedType.name, field.name));
        markEntireTypeAsUsed(field.type);
      }
    }

    function collectVariable(namedType: GraphQLNamedInputType, variableValue: unknown) {
      const variableValueArray = Array.isArray(variableValue) ? variableValue : [variableValue];
      if (isInputObjectType(namedType)) {
        variableValueArray.forEach(variable => {
          if (variable) {
            // Collect only the used fields
            for (const fieldName in variable) {
              const field = namedType.getFields()[fieldName];
              if (field) {
                collectInputType(namedType.name, fieldName);
                collectVariable(unwrapType(field.type), variable[fieldName]);
              }
            }
          } else {
            // Collect type without fields
            markAsUsed(makeId(namedType.name));
          }
        });
      } else {
        collectInputType(namedType.name);
      }
    }

    visit(
      doc,
      visitWithTypeInfo(typeInfo, {
        Field() {
          const parent = typeInfo.getParentType()!;
          const field = typeInfo.getFieldDef()!;

          markAsUsed(makeId(parent.name, field.name));
        },
        VariableDefinition(node) {
          const inputType = typeInfo.getInputType()!;

          if (shouldAnalyzeVariableValues) {
            // Granular collection of variable values is enabled
            const variableName = node.variable.name.value;
            const variableValue = variables[variableName];
            const namedType = unwrapType(inputType);

            collectVariable(namedType, variableValue);
          } else {
            // Collect the entire type without processing the variables
            collectInputType(resolveTypeName(inputType));
          }
        },
        Argument(node) {
          const parent = typeInfo.getParentType()!;
          const field = typeInfo.getFieldDef()!;
          const arg = typeInfo.getArgument()!;

          try {
            markAsUsed(makeId(parent.name, field.name, arg.name));
          } catch (e) {
            const info = {
              name: node.name,
              value: node.value,
              parent: parent,
              field: field,
              arg: arg,
            };
            const msg = Object.entries(info).map(([key, value]) => `${key}='${value}'`);

            console.error(`Failed to collect argument node. ${msg}`);
          }
          collectNode(node);
        },
        ListValue(node) {
          const inputType = typeInfo.getInputType()!;
          const inputTypeName = resolveTypeName(inputType);

          node.values.forEach(value => {
            if (value.kind !== Kind.OBJECT) {
              // if a value is not an object we need to collect all fields
              collectInputType(inputTypeName);
            }
          });
        },
        ObjectField(node) {
          const parentInputType = typeInfo.getParentInputType()!;
          const parentInputTypeName = resolveTypeName(parentInputType);

          collectNode(node);
          collectInputType(parentInputTypeName, node.name.value);
        },
      }),
    );

    for (const inputTypeName in collectedInputTypes) {
      const { fields, all } = collectedInputTypes[inputTypeName];

      if (all) {
        markEntireTypeAsUsed(schema.getType(inputTypeName) as any);
      } else {
        fields.forEach(field => {
          markAsUsed(makeId(inputTypeName, field));
        });
      }
    }

    return {
      document: normalizeOperation({
        document: doc,
        hideLiterals: true,
        removeAliases: true,
      }),
      fields: Array.from(entries),
    };
  }

  return cache(
    collect,
    function cacheKey(doc, variables) {
      return cacheDocumentKey(doc, processVariables === true ? variables : null);
    },
    LRU<CacheResult>(max, ttl),
  );
}

function resolveTypeName(inputType: GraphQLType): string {
  return unwrapType(inputType).name;
}

function unwrapType(type: GraphQLInputType): GraphQLNamedInputType;
function unwrapType(type: GraphQLOutputType): GraphQLNamedOutputType;
function unwrapType(type: GraphQLType): GraphQLNamedType;
function unwrapType(type: GraphQLType): GraphQLNamedType {
  if (isNonNullType(type) || isListType(type)) {
    return unwrapType(type.ofType);
  }

  return type;
}

type GraphQLNamedInputType = Exclude<
  GraphQLNamedType,
  GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType
>;
type GraphQLNamedOutputType = Exclude<GraphQLNamedType, GraphQLInputObjectType>;

export interface Report {
  size: number;
  map: OperationMap;
  operations: Operation[];
}

interface CollectedOperation {
  key: string;
  timestamp: number;
  operation: string;
  operationName?: string | null;
  fields: string[];
  execution: {
    ok: boolean;
    duration: number;
    errorsTotal: number;
    errors?: Array<{
      message: string;
      path?: string;
    }>;
  };
  client?: ClientInfo | null;
}

interface Operation {
  operationMapKey: string;
  timestamp: number;
  execution: {
    ok: boolean;
    duration: number;
    errorsTotal: number;
    errors?: Array<{
      message: string;
      path?: string;
    }>;
  };
  metadata?: {
    client?: {
      name?: string;
      version?: string;
    } | null;
  };
}

interface OperationMapRecord {
  operation: string;
  operationName?: string | null;
  fields: string[];
}

interface OperationMap {
  [key: string]: OperationMapRecord;
}
