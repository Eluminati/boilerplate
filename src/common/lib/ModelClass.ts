import { v4 as uuid } from "uuid";
import MetadataStore from "~common/lib/MetadataStore";
import BaseAttribute from "~env/lib/BaseAttribute";
import { hasOwnProperty, camelCase } from "~env/utils/utils";
import type { Constructor } from "type-fest";
import type { ModelOptions } from "~common/@types/ModelClass";
import type BaseModel from "~env/lib/BaseModel";

// Here we are storing all attributes during construction time to have access
// to them when creating an attribute. This is possible with some webpack magic.
// see https://webpack.js.org/guides/dependency-management/#requirecontext
const attributes: Record<string, Constructor<BaseAttribute<typeof BaseModel>>> = {};
const context = require.context("~env/attributes/", true, /.+\.ts/, "sync");
context.keys().forEach((key) => {
    attributes[camelCase(key.substring(2, key.length - 3))] = (<ModuleLike<Constructor<BaseAttribute<typeof BaseModel>>>>context(key)).default;
});

/**
 * Creates a class which extends the given model class and wraps the class with
 * an additional proxy to be able to control fields which are normally immutable
 * or not existent on static classes, like the constructors name.
 * It also manipulates the prototype chain to avoid doubling behavior of
 * already extended model classes.
 *
 * @param ctor the model class to extend with immutable model behavior
 * @param options options to use for extension
 * @returns the model class proxy
 */
export default function ModelClassFactory<T extends typeof BaseModel>(ctor: T & { isModelClass: boolean }, options: ModelOptions<T>) {

    // Remove ModelClass from prototype chain of ctor to avoid double registration
    // of proxy and other ModelClass stuff
    if (ctor.isModelClass) {
        const classPrototype = Reflect.getPrototypeOf(ctor);
        const prototype = classPrototype && Reflect.getPrototypeOf(classPrototype) as typeof ctor | null;
        if (classPrototype && prototype && prototype.isModelClass) Reflect.setPrototypeOf(classPrototype, Reflect.getPrototypeOf(prototype));
    }

    // eslint-disable-next-line prefer-const
    let constructorProxy: any;

    /**
     * Sets className and collectionName as well as it traps attribute getter
     * and setter and handles reactivity for the model and wrapping frameworks.
     * It also creates the attributes and sets the unProxyfiedModel in the
     * models instance.
     */
    class ModelClass extends ctor {

        /**
         * Identifies a model as a model class. This is needed because we are
         * not able to use the ModelClass as a value for "instanceof"
         * (because it's inside a factory). This is for example used above when
         * manipulating prototype chain.
         */
        public static override isModelClass = true;

        /**
         * @inheritdoc
         */
        public static override readonly className = options.className as string;

        /**
         * @inheritdoc
         */
        public static override readonly collectionName = options.collectionName as string;

        /**
         * @see ModelClass.isModelClass
         */
        public isModelClass = true;

        /**
         * @inheritdoc
         */
        public override readonly className: string = options.className as string;

        /**
         * @inheritdoc
         */
        public override readonly collectionName: string = options.collectionName as string;

        public constructor(...args: any[]) {
            super(...args);
            // @ts-expect-error yes it's read only but not during construction...
            this.unProxyfiedModel = this;

            let proxy = new Proxy(this, this.proxyHandler);
            proxy = this.addReactivity(proxy);
            this.createAttributes(proxy);
            Object.assign(proxy, this.mergeProperties(proxy, args?.[0]));
            // If this is an initialization of an existing model, we dont
            // want to have the changes
            if (args?.[0]?.id) proxy.removeChanges();
            return proxy;
        }

        /**
         * The proxy handler object for the instance proxy. This has to be
         * complete to ensure a full working proxy
         */
        private get proxyHandler(): ProxyHandler<this> {
            return {
                get: this.get.bind(this),
                set: this.set.bind(this),
                defineProperty: (target, propertyName, attributes) => Reflect.defineProperty(target, propertyName, attributes),
                deleteProperty: (target, propertyName) => Reflect.deleteProperty(target, propertyName),
                apply: (target, thisArg, argArray) => Reflect.apply(<any>target, thisArg, argArray),
                has: (target, propertyName) => Reflect.has(target, propertyName),
                getOwnPropertyDescriptor: (target, propertyName) => Reflect.getOwnPropertyDescriptor(target, propertyName),
                setPrototypeOf: (target, v) => Reflect.setPrototypeOf(target, v),
                getPrototypeOf: (target) => Reflect.getPrototypeOf(target),
                ownKeys: this.getPropertyNames.bind(this),
                isExtensible: (target) => Reflect.isExtensible(target),
                preventExtensions: (target) => Reflect.preventExtensions(target),
                construct: (target, argArray) => Reflect.construct(<any>target, argArray)
            };
        }

        /**
         * @inheritdoc
         */
        protected mergeProperties(proxy: this, properties: Record<string, any> = {}) {
            const defaults: Record<string, unknown> = {};
            // Has to be called with the proxy because the attributes are
            // stored on the proxy, not the raw class
            const attributes = proxy.getAttributes();
            for (const attribute of attributes) {
                defaults[attribute.name] = this[attribute.name];
                Reflect.set(this, attribute.name, undefined); // Set to undefined to trigger the init change
            }

            if (!properties.id) defaults.dummyId = uuid();
            return proxy.prePropertyMixin(Object.assign(defaults, properties));
        }

        /**
         * Creates attributes corresponding to their names. if the name of the
         * attribute is test and there is a TestAttribute class, this class
         * will be invoked. Otherwise the BaseAttribute will be invoked.
         *
         * @param proxy the proxy which should recognize all changes of the attributes
         */
        private createAttributes(proxy: this) {
            const metadataStore = new MetadataStore();
            const attributeSchemas = this.getSchema()?.attributeSchemas || {};
            for (const key in attributeSchemas) {
                if (hasOwnProperty(attributeSchemas, key)) {
                    const attribute = new (attributes[key] || BaseAttribute)(proxy, key, Reflect.get(attributeSchemas, key));
                    metadataStore.setAttribute(proxy, key, attribute);
                }
            }
        }

        /**
         * This is the "ownKeys" trap of the instance proxy
         *
         * @returns array of attribute names
         */
        private getPropertyNames() {
            return Object.keys(this.getSchema()?.attributeSchemas || {});
        }

        /**
         * This is the get trap of the instance proxy. It distinguishes between
         * attributes and normal properties and reacts corresponding on the type.
         * If the property is an attribute it calls its getter and returns its value.
         *
         * @param target the proxy wrapped instance of the model
         * @param propertyName the name of the accessed property
         * @param receiver the instance of the model without proxy
         * @returns the value of the asked attribute or property
         */
        private get(target: this, propertyName: string | symbol, receiver: this) {
            // because we manipulate the constructor name on the fly, we need to
            // return that manipulating proxy (see below) to ensure that behavior
            if (propertyName === "constructor") return constructorProxy;

            const metadataStore = new MetadataStore();
            const attributeSchemas = this.getSchema()?.attributeSchemas;
            const stringProperty = propertyName.toString();
            if (!attributeSchemas || !hasOwnProperty(attributeSchemas, stringProperty)) return Reflect.get(target, propertyName);
            // Because the attribute is stores on the model instance and not on
            // the proxy, we have to get the attribute from the receiver which
            // is equal to the unProxyfiedModel
            return metadataStore.getAttribute(receiver, stringProperty)?.get();
        }

        /**
         * This is the set trap of the instance proxy. Like the getter it
         * distinguishes between attributes and normal properties. If the
         * property is an attribute, it calls its setter and returns its return
         * value. This has to be a boolean. Otherwise JS will throw a ValueError.
         *
         * @param target the proxy wrapped instance of the model
         * @param propertyName the name of the accessed property
         * @param value the value which has to be set on the property
         * @param receiver the instance of the model without proxy
         * @returns the value of the asked attribute or property
         */
        private set(target: this, propertyName: string | symbol, value: any, receiver: this) {
            const metadataStore = new MetadataStore();
            const attributeSchemas = this.getSchema()?.attributeSchemas;
            const stringProperty = propertyName.toString();
            if (!attributeSchemas || !hasOwnProperty(attributeSchemas, stringProperty)) return Reflect.set(target, propertyName, value);
            // Because the attribute is stores on the model instance and not on
            // the proxy, we have to get the attribute from the receiver which
            // is equal to the unProxyfiedModel
            return metadataStore.getAttribute(receiver, stringProperty)?.set(value) ?? false;
        }

    }

    // Manipulate the constructor name to be able to store the data in the
    // database the right way and to be able to minify the className on compile time
    // We need to disable that lint on this line to be able to provide the variable above
    // eslint-disable-next-line prefer-const
    constructorProxy = new Proxy(ModelClass, { get: (target, property) => property === "name" ? options.className : Reflect.get(target, property) });
    return constructorProxy;
}
