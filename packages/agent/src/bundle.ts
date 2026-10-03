/**
 * `Bundle` namespace assembly (#1254): the core bundle/compose surface plus
 * the removable `plugins/alarm` capability the app composes. Root assembly
 * files are the one legal meeting point of core and plugin bands (#1276);
 * neither side imports the other directly.
 */
export * from "./core/bundle";
export * from "./plugins/alarm";
