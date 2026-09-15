import type { Group } from "@prisma/client";
import { prisma } from "../db.js";

export async function findOrCreateGroup(whatsappGroupId: string, name: string | null): Promise<Group> {
  const existing = await prisma.group.findUnique({ where: { whatsappGroupId } });
  if (existing) {
    if (name && existing.name !== name) {
      return prisma.group.update({ where: { id: existing.id }, data: { name } });
    }
    return existing;
  }
  return prisma.group.create({ data: { whatsappGroupId, name } });
}
