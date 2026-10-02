/**
 * @ReadReplica() decorator (#411).
 *
 * Marks a repository method so the PrismaReplicaService will route the
 * call to a healthy read replica instead of the primary.
 *
 * Usage:
 *   @ReadReplica()
 *   async findAll(): Promise<Intent[]> { ... }
 *
 * The decorator stores metadata; the actual routing is done by
 * PrismaReplicaService.pickClient().
 */
export const READ_REPLICA_METADATA_KEY = "use-read-replica";

export function ReadReplica(): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    _descriptor: PropertyDescriptor,
  ): void => {
    Reflect.defineMetadata(READ_REPLICA_METADATA_KEY, true, target, propertyKey);
  };
}

/** Returns true when a class method is decorated with @ReadReplica(). */
export function isReadReplicaMethod(target: object, propertyKey: string | symbol): boolean {
  return Reflect.getMetadata(READ_REPLICA_METADATA_KEY, target, propertyKey) === true;
}
