export const roles = ["admin", "reviewer", "editor", "viewer"] as const;
export type Role = (typeof roles)[number];
export type Access = { workspace: string; actor: string; role: Role };
export const permissions = {
  read: roles,
  edit: ["admin", "reviewer", "editor"],
  review: ["admin", "reviewer"],
  manage: ["admin"],
} as const;
export type Permission = keyof typeof permissions;

export function can(role: Role, permission: Permission) {
  return (permissions[permission] as readonly Role[]).includes(role);
}
