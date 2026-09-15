-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "authenticityNotes" TEXT,
ADD COLUMN     "authenticityVerdict" TEXT,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "marketPriceMax" INTEGER,
ADD COLUMN     "marketPriceMin" INTEGER,
ADD COLUMN     "priceNotes" TEXT,
ADD COLUMN     "priceVerdict" TEXT;
