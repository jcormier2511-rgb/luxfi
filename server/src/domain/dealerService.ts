import type { Dealer } from "@prisma/client";
import { prisma } from "../db.js";

export async function findOrCreateDealer(whatsappId: string, name: string | null): Promise<Dealer> {
  const existing = await prisma.dealer.findUnique({ where: { whatsappId } });
  if (existing) {
    // Keep the display name fresh if WhatsApp reports a new one and we don't have one yet.
    if (name && !existing.name) {
      return prisma.dealer.update({ where: { id: existing.id }, data: { name } });
    }
    return existing;
  }
  return prisma.dealer.create({ data: { whatsappId, name } });
}

export async function findDealerByNameLike(nameFragment: string): Promise<Dealer | null> {
  const cleaned = nameFragment.replace(/^@/, "").trim();
  if (!cleaned) return null;
  return prisma.dealer.findFirst({
    where: { name: { contains: cleaned, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
  });
}
