-- CreateTable
CREATE TABLE "ai_jobs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "stage" "Stage",
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "result" JSONB,
    "error" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_jobs_projectId_status_idx" ON "ai_jobs"("projectId", "status");

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Solo un trabajo de IA en curso por proyecto.
CREATE UNIQUE INDEX "ai_jobs_one_running_per_project" ON "ai_jobs"("projectId") WHERE "status" = 'running';
