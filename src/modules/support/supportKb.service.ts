import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { supportKbArticles } from "../../db/schema";
import { AppError } from "../../lib/errors";
import type { AccountRole } from "./support.service";

// The support bot's help library — admin-written articles it answers from.

type Article = typeof supportKbArticles.$inferSelect;
export type ArticleInput = Pick<Article, "title" | "content" | "audience" | "active">;

export async function listArticles() {
  return db.select().from(supportKbArticles).orderBy(desc(supportKbArticles.updatedAt));
}

// Stable order (oldest first) so the bot's instructions are byte-identical
// between replies until an admin edits an article — that's what lets the
// prompt cache hit.
export async function listActiveArticlesFor(role: AccountRole): Promise<Article[]> {
  return db
    .select()
    .from(supportKbArticles)
    .where(and(eq(supportKbArticles.active, true), inArray(supportKbArticles.audience, [role, "all"])))
    .orderBy(asc(supportKbArticles.createdAt), asc(supportKbArticles.id));
}

export async function createArticle(input: ArticleInput): Promise<Article> {
  const [article] = await db.insert(supportKbArticles).values(input).returning();
  return article;
}

export async function updateArticle(id: string, input: Partial<ArticleInput>): Promise<Article> {
  const [article] = await db
    .update(supportKbArticles)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(supportKbArticles.id, id))
    .returning();
  if (!article) throw new AppError(404, "Article not found");
  return article;
}

export async function deleteArticle(id: string): Promise<Article> {
  const [article] = await db.delete(supportKbArticles).where(eq(supportKbArticles.id, id)).returning();
  if (!article) throw new AppError(404, "Article not found");
  return article;
}
