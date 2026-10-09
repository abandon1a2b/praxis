import { z } from "zod";
import path from "node:path";

const patternList = z.array(z.string().min(1).max(500)).max(100).default([]);
export const businessSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(false),
    repositories: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
            path: z
              .string()
              .min(1)
              .refine(
                (p) => path.isAbsolute(p),
                "Use an absolute repository path",
              ),
            include: patternList,
            exclude: patternList,
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .refine(
        (repos) => new Set(repos.map((r) => r.name)).size === repos.length,
        "Repository names must be unique",
      ),
    model: z
      .object({
        provider: z.string().min(1),
        id: z.string().min(1),
        thinking: z
          .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
          .default("low"),
      })
      .strict(),
    intervalSeconds: z.number().int().min(60).max(2147483).default(86400),
    batchCharacters: z.number().int().min(1000).max(100000).default(40000),
    timeoutSeconds: z.number().int().min(1).max(3600).default(180),
    focus: z.string().trim().min(1).max(4000),
  })
  .strict();

export function executionConfig(business) {
  const { name, enabled, ...config } = business;
  return config;
}
