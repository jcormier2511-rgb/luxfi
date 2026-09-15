-- CreateEnum
CREATE TYPE "ListingType" AS ENUM ('WTB', 'FS');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('OPEN', 'MATCHED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrustTier" AS ENUM ('UNVERIFIED', 'VERIFIED', 'ELITE');

-- CreateTable
CREATE TABLE "Dealer" (
    "id" TEXT NOT NULL,
    "whatsappId" TEXT NOT NULL,
    "name" TEXT,
    "trustTier" "TrustTier" NOT NULL DEFAULT 'UNVERIFIED',
    "vouchCount" INTEGER NOT NULL DEFAULT 0,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "freeMatchesUsed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dealer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "whatsappGroupId" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "type" "ListingType" NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'OPEN',
    "category" TEXT NOT NULL DEFAULT 'watch',
    "brand" TEXT,
    "reference" TEXT,
    "model" TEXT,
    "condition" TEXT,
    "priceMin" INTEGER,
    "priceMax" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "location" TEXT,
    "notes" TEXT,
    "rawText" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "wtbListingId" TEXT NOT NULL,
    "fsListingId" TEXT NOT NULL,
    "buyerDealerId" TEXT NOT NULL,
    "sellerDealerId" TEXT NOT NULL,
    "creditsChargedBuyer" INTEGER NOT NULL DEFAULT 0,
    "creditsChargedSeller" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "subjectDealerId" TEXT NOT NULL,
    "reviewerDealerId" TEXT,
    "rating" INTEGER,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'chat_history',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VouchRequest" (
    "id" TEXT NOT NULL,
    "requesterDealerId" TEXT NOT NULL,
    "targetDealerId" TEXT NOT NULL,
    "dealText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VouchRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawMessage" (
    "id" TEXT NOT NULL,
    "whatsappMsgId" TEXT,
    "chatId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderName" TEXT,
    "text" TEXT NOT NULL,
    "isGroup" BOOLEAN NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dealer_whatsappId_key" ON "Dealer"("whatsappId");

-- CreateIndex
CREATE INDEX "Dealer_name_idx" ON "Dealer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Group_whatsappGroupId_key" ON "Group"("whatsappGroupId");

-- CreateIndex
CREATE INDEX "Listing_type_status_category_brand_idx" ON "Listing"("type", "status", "category", "brand");

-- CreateIndex
CREATE INDEX "Listing_reference_idx" ON "Listing"("reference");

-- CreateIndex
CREATE INDEX "Review_subjectDealerId_idx" ON "Review"("subjectDealerId");

-- CreateIndex
CREATE INDEX "VouchRequest_targetDealerId_status_idx" ON "VouchRequest"("targetDealerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RawMessage_whatsappMsgId_key" ON "RawMessage"("whatsappMsgId");

-- CreateIndex
CREATE INDEX "RawMessage_chatId_idx" ON "RawMessage"("chatId");

-- CreateIndex
CREATE INDEX "RawMessage_senderId_idx" ON "RawMessage"("senderId");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_wtbListingId_fkey" FOREIGN KEY ("wtbListingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_fsListingId_fkey" FOREIGN KEY ("fsListingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_buyerDealerId_fkey" FOREIGN KEY ("buyerDealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_sellerDealerId_fkey" FOREIGN KEY ("sellerDealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_subjectDealerId_fkey" FOREIGN KEY ("subjectDealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_reviewerDealerId_fkey" FOREIGN KEY ("reviewerDealerId") REFERENCES "Dealer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VouchRequest" ADD CONSTRAINT "VouchRequest_requesterDealerId_fkey" FOREIGN KEY ("requesterDealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VouchRequest" ADD CONSTRAINT "VouchRequest_targetDealerId_fkey" FOREIGN KEY ("targetDealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
