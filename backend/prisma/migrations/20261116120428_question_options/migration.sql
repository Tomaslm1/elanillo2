-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "options" TEXT[] DEFAULT ARRAY[]::TEXT[];
