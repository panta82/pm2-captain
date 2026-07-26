import libPath from 'path';

import { assert } from './assertions';
import { CustomError } from './errors';
import { typedValues } from './tools';
import { StringKeys } from './types';

export interface IServiceDefinitionImporter<TDefinition extends { identifier: string }> {
  identifier: TDefinition['identifier'];
  require: () => TDefinition;
}

/**
 * Wrap service import function into this method. Eg. importer(() => import('./x'))
 */
export function importer<
  TModule extends () => Promise<{ [key in TModuleKey]: any }>,
  TModuleKey extends string = 'default',
>(
  identifier: Awaited<ReturnType<TModule>>[TModuleKey]['identifier'],
  importerWrapper: TModule,
  moduleKey?: TModuleKey,
  importerDirectoryFullPath: string = __dirname
): IServiceDefinitionImporter<Awaited<ReturnType<TModule>>[TModuleKey]> {
  const target = {} as { stack: string };
  Error.captureStackTrace(target);
  const lines = target.stack.split('\n');
  const [importerPath, callerPath] = [lines[1], lines[2]].map(line =>
    libPath.dirname(line.match(/\(([^)]+?)(?::[0-9]+)?(?::[0-9]+)?\)/)?.[1] || '')
  );
  const importerToCallerRelativePath = libPath.relative(importerPath, callerPath);

  const requirePath = importerWrapper.toString()?.match(/['"]([^'"]+)['"]/)?.[1];
  assert(requirePath, `Invalid importerWrapper function: ${importerWrapper.toString()}`);

  const finalPath = libPath.resolve(
    importerDirectoryFullPath,
    importerToCallerRelativePath,
    requirePath
  );

  return {
    identifier,
    require: () => {
      return require(finalPath)[moduleKey || ('default' as any)];
    },
  };
}

export type IImporterTupleToServiceImporters<
  TTuple extends readonly { identifier: string; require: () => any }[],
> = {
  [importer in TTuple[number] as importer['identifier']]: importer;
};

// *********************************************************************************************************************

export type IDependencyInjectionType = 'singleton' | 'targeted';

interface IAdditionalDefineOptions {
  name?: string;
  identifier?: string;
  injection?: IDependencyInjectionType;
  flags?: string[];
}
type IAdditionalDefineOptionsKeys = keyof IAdditionalDefineOptions;

export interface IServiceDefinitionBase {
  name: string;
  identifier: string;
  factory: (...args: any[]) => any;
  injection: IDependencyInjectionType;
  flags?: string[];
}

export interface IServiceDefinition<
  TDefinition extends {
    [key: `create${string}`]: (...args: any[]) => any;
  } & IAdditionalDefineOptions,
> extends IServiceDefinitionBase {
  name: TDefinition extends { name: string }
    ? TDefinition['name']
    : Exclude<keyof TDefinition, IAdditionalDefineOptionsKeys> extends `create${infer U}`
      ? U
      : never;
  identifier: TDefinition extends { identifier: string }
    ? TDefinition['identifier']
    : Exclude<keyof TDefinition, IAdditionalDefineOptionsKeys> extends `create${infer U}`
      ? Uncapitalize<U>
      : never;
  factory: Exclude<keyof TDefinition, IAdditionalDefineOptionsKeys> extends `create${infer U}`
    ? TDefinition[`create${U}`]
    : never;
  injection: TDefinition['injection'] extends string ? TDefinition['injection'] : 'singleton';
}

export function define<
  TDefineOptions extends {
    [key: `create${string}`]: (...args: any[]) => any;
  } & IAdditionalDefineOptions,
>(defineOptions: TDefineOptions): IServiceDefinition<TDefineOptions> {
  for (const key in defineOptions) {
    if (defineOptions.hasOwnProperty(key) && key.startsWith('create')) {
      const autoName = key.slice(6);
      const name = defineOptions.name || autoName;
      return {
        name,
        identifier: defineOptions.identifier || autoName[0].toLowerCase() + autoName.slice(1),
        factory: defineOptions[key],
        injection: defineOptions.injection || 'singleton',
        flags: defineOptions.flags,
      } as any;
    }
  }

  throw new ContainerError(`Invalid definition options! No "createX" method found`);
}

// *********************************************************************************************************************

/** Declaration merging target */
export interface IServiceImporters {}

export type IServiceIdentifier = StringKeys<IServiceImporters>;
type IServiceImporterUnion = IServiceImporters[IServiceIdentifier];

type IServiceDefinitions = {
  [importer in IServiceImporterUnion as importer['identifier']]: ReturnType<importer['require']>;
};
type IServiceDefinitionUnion = IServiceDefinitions[IServiceIdentifier];

export type IServiceInstances = {
  [definition in IServiceDefinitionUnion as definition['identifier']]: ReturnType<
    definition['factory']
  >;
};

export type IServiceName = IServiceDefinitions[IServiceIdentifier]['name'];

type IServiceIdentifierToName = {
  [definition in IServiceDefinitionUnion as definition['identifier']]: definition['name'];
};

type IServiceNameToIdentifier = {
  [definition in IServiceDefinitionUnion as definition['name']]: definition['identifier'];
};

// *********************************************************************************************************************

export interface IServiceInfoBase extends IServiceDefinitionBase {
  index: number;
  instance: any;
  instanceProxy: any;
  instanceConstructing: boolean;
  injection: IDependencyInjectionType;
  flags: string[];
}

export interface IServiceInfo<TIdentifier extends IServiceIdentifier, TSettings>
  extends IServiceInfoBase {
  name: IServiceDefinitions[TIdentifier]['name'];
  identifier: TIdentifier;
  factory: (
    container: IDIContainer<TSettings>,
    injectionTarget?: IServiceInfoBase | null
  ) => IServiceInstances[TIdentifier];
}

// *********************************************************************************************************************

export interface IDIContainer<TSettings> extends IServiceInstances {
  container: IDIContainer<TSettings>;
  settings: TSettings;
  identifiers: IServiceIdentifier[];
  listServiceInfos(): Array<IServiceInfo<IServiceIdentifier, TSettings>>;
  getService<TIdentifier extends IServiceIdentifier>(
    identifier: TIdentifier
  ): IServiceInstances[TIdentifier];
}

interface IIndexedServiceDefinitionImporter extends IServiceDefinitionImporter<any> {
  index: number;
}

export function createContainer<TSettings>(
  settings: TSettings,
  serviceImporters: readonly IServiceImporterUnion[]
): IDIContainer<TSettings> {
  const identifiers: IServiceIdentifier[] = [];
  const serviceImporterLookup: { [identifier: string]: IIndexedServiceDefinitionImporter } = {};
  for (let i = 0; i < serviceImporters.length; i++) {
    const importer = serviceImporters[i] as any as IServiceDefinitionImporter<any>;
    serviceImporterLookup[importer.identifier] = {
      ...importer,
      index: i,
    };
    identifiers.push(importer.identifier as IServiceIdentifier);
  }

  const _serviceInfoLookup: {
    [identifier: string]: IServiceInfo<IServiceIdentifier, TSettings>;
  } = {};
  let _resolvedCount = 0;

  const container = new (class Container {
    settings = settings;

    get identifiers() {
      return identifiers;
    }

    listServiceInfos() {
      if (_resolvedCount < serviceImporters.length) {
        for (const importer of serviceImporters) {
          const typedImporter = importer as any as IServiceDefinitionImporter<any>;
          if (!_serviceInfoLookup[typedImporter.identifier]) {
            _serviceInfoLookup[typedImporter.identifier] = resolveServiceInfo(
              serviceImporterLookup[typedImporter.identifier]
            );
            _resolvedCount++;
          }
        }
      }
      return typedValues(_serviceInfoLookup);
    }

    getService<TIdentifier extends IServiceIdentifier>(identifier: TIdentifier) {
      return getService(identifier);
    }
  })() as IDIContainer<TSettings>;

  container.container = container;

  for (const serviceImporter of serviceImporters) {
    const typedImporter = serviceImporter as any as IServiceDefinitionImporter<any>;
    Object.defineProperty(container, typedImporter.identifier, {
      get() {
        return getService(typedImporter.identifier as IServiceIdentifier);
      },
    });
  }

  return container;

  function resolveServiceInfo(serviceImporter: IIndexedServiceDefinitionImporter) {
    const serviceDefinition = serviceImporter.require();

    const info: IServiceInfo<IServiceIdentifier, TSettings> = {
      index: serviceImporter.index,
      name: serviceDefinition.name,
      identifier: serviceDefinition.identifier,
      flags: serviceDefinition.flags || [],
      factory: serviceDefinition.factory as any,
      injection: serviceDefinition.injection || 'singleton',
      instance: null,
      instanceProxy: null,
      instanceConstructing: false,
    };

    return info;
  }

  function getService<TIdentifier extends IServiceIdentifier>(
    identifier: TIdentifier,
    forServiceIdentifier?: IServiceIdentifier
  ): IServiceInstances[TIdentifier] {
    if (!_serviceInfoLookup[identifier] && serviceImporterLookup[identifier]) {
      _serviceInfoLookup[identifier] = resolveServiceInfo(serviceImporterLookup[identifier]);
      _resolvedCount++;
    }

    const info = _serviceInfoLookup[identifier] as unknown as IServiceInfo<TIdentifier, TSettings>;
    if (!info) {
      throw new ServiceNotFoundError(identifier);
    }

    if (info.injection === 'targeted') {
      // Targeted injection can be called many times, so we don't need to track creation
      const forService = forServiceIdentifier ? _serviceInfoLookup[forServiceIdentifier] : null;
      if (forServiceIdentifier && !forService) {
        throw new ServiceNotFoundError(forServiceIdentifier);
      }

      return info.factory(createInjection(info), forService);
    }

    if (info.instance) {
      // Just return the instance
      return info.instance;
    }

    if (info.instanceProxy) {
      // This can happen due to circular dependencies. Provide an existing proxy to an instance.
      return info.instanceProxy;
    }

    // If instance is being constructed, we need to create a proxy to the (future) instance
    if (info.instanceConstructing) {
      info.instanceProxy = createInstanceProxy(info);
      return info.instanceProxy;
    }

    // Create a new instance
    try {
      info.instanceConstructing = true;
      const instance = info.factory(createInjection(info));
      info.instance = instance;
      return instance;
    } finally {
      info.instanceConstructing = false;
    }
  }

  function createInjection<TIdentifier extends IServiceIdentifier>(
    info: IServiceInfo<TIdentifier, TSettings>
  ): IDIContainer<TSettings> {
    const injection = new Proxy(container, {
      get(target, prop) {
        if (prop in target) {
          return (target as any)[prop];
        }

        return getService(prop as TIdentifier, info.identifier);
      },
    });
    return injection;
  }

  function createInstanceProxy<TIdentifier extends IServiceIdentifier>(
    info: IServiceInfo<TIdentifier, TSettings>
  ): IServiceInstances[TIdentifier] {
    const proxy = new Proxy<IServiceInstances[TIdentifier]>({} as any, {
      get(target: any, prop) {
        if (prop in target) {
          return target[prop];
        }

        if (info.instance) {
          return info.instance[prop];
        }

        throw new InstanceNotReadyError(info.name);
      },
      set(target, prop, value) {
        if (info.instance) {
          info.instance[prop] = value;
        } else {
          throw new InstanceNotReadyError(info.name);
        }
        return true;
      },
      deleteProperty(target, prop) {
        if (info.instance) {
          delete info.instance[prop as string];
        } else {
          throw new InstanceNotReadyError(info.name);
        }
        return true;
      },
    });
    return proxy;
  }
}

class ContainerError extends CustomError {}

class ServiceNotFoundError extends ContainerError {
  constructor(public identifier: string) {
    super(`Service "${identifier}" not found`);
  }
}

class InstanceNotReadyError extends ContainerError {
  constructor(public identifier: string) {
    super(
      `Service "${identifier}" is still being constructed and is not ready yet. Try accessing the instance asynchronously.`
    );
  }
}
