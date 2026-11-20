/** Random, collision-resistant ids for local records (UUID v4 without dashes). */
export function createId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
