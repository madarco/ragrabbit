import { UserError } from "@repo/core";
import db from "@repo/db";
import { and, eq, not } from "@repo/db/drizzle";
import { Indexed, indexedContentTable, indexedTable, normalizeUrl } from "@repo/db/schema";
import { logger } from "@repo/logger";
import crypto from "crypto";
import { cleanAndExtraMetadata, scrapeUrl } from "./scraping";

export async function scrapeDbItem(indexedId: number) {
  logger.info("Scraping content", { indexedId });

  const indexed = await db.query.indexedTable.findFirst({
    where: eq(indexedTable.id, indexedId),
    with: {
      foundFromIndex: true,
    },
  });
  if (!indexed) {
    throw new UserError("Index page not found");
  }

  await db
    .update(indexedTable)
    .set({
      status: "PROCESSING",
      indexedAt: new Date(),
    } as Indexed)
    .where(eq(indexedTable.id, indexed.id));

  if (indexed.doCrawl) {
    // Mark all child pages as outdated to be re-processed:
    await db
      .update(indexedTable)
      .set({
        status: "OUTDATED",
      } as Indexed)
      .where(eq(indexedTable.foundFromIndexId, indexed.id));
  }

  //Fetch page content:
  const scrapeOptions = indexed.foundFromIndex?.scrapeOptions || indexed.scrapeOptions || {};
  const scrapeData = await scrapeUrl(indexed.url, scrapeOptions);
  let { body, title, description, links, canonicalUrl, unsuportedContent, contentType } = scrapeData;

  canonicalUrl = canonicalUrl ? normalizeUrl(canonicalUrl, indexed.url) : undefined;

  if (unsuportedContent) {
    logger.info("Unsupported content type", { contentType });
    return skipIndexed(indexed, "Unsupported content type: " + contentType, canonicalUrl);
  }

  // check if this page is already indexed as a different url:
  if (canonicalUrl && canonicalUrl !== indexed.normalizedUrl) {
    const existing = await db.query.indexedTable.findFirst({
      where: eq(indexedTable.normalizedUrl, normalizeUrl(canonicalUrl)),
    });
    if (existing) {
      logger.info("Canonical URL already indexed", { canonicalUrl });
      return skipIndexed(indexed, `Same canonical url of: ${existing.url}`, canonicalUrl);
    }
  }

  // Check if the content has changed:
  const hash = await hashContent(body);
  if (hash !== indexed.hash) {
    logger.debug({ indexedId, hash, oldHash: indexed.hash }, "Content has changed");
    // Check if this identical content has already been indexed by another url:
    const existing = await db.query.indexedTable.findFirst({
      where: and(
        eq(indexedTable.organizationId, indexed.organizationId),
        eq(indexedTable.hash, hash),
        not(eq(indexedTable.id, indexed.id))
      ),
    });
    if (existing) {
      logger.info("Content already indexed with a different url", {
        indexedId,
        existingId: existing.id,
        url: indexed.normalizedUrl,
        existingUrl: existing.normalizedUrl,
      });
      return skipIndexed(indexed, "Duplicated content from: " + existing.url);
    }

    const { content, metadata } = await cleanAndExtraMetadata(scrapeOptions, body, indexed.url, title);
    if (!title) {
      title = metadata.pageTitle;
    }
    if (!description) {
      description = metadata.pageDescription;
    }
    if (!content) {
      throw new UserError("No content found in page");
    }
    logger.debug("Created Markdown content", { bytes: content.length });

    await db
      .insert(indexedContentTable)
      .values({ indexId: indexed.id, content })
      .onConflictDoUpdate({ target: indexedContentTable.indexId, set: { content } });

    await db
      .update(indexedTable)
      .set({
        title,
        description,
        hash,
        ...(indexed.canonicalUrl ? { canonicalUrl: canonicalUrl } : {}),
        status: "SCRAPED",
        metadata,
        indexedAt: new Date(),
      } as Indexed)
      .where(eq(indexedTable.id, indexed.id));
    indexed.status = "SCRAPED";
  } else {
    logger.info("Content is identical to the previous indexed content", { indexedId });
    await db
      .update(indexedTable)
      .set({
        status: indexed.doCrawl ? "PENDING_CLEAN" : "DONE",
        indexedAt: new Date(),
        updatedAt: new Date(),
      } as Indexed)
      .where(eq(indexedTable.id, indexed.id));
    indexed.status = indexed.doCrawl ? "PENDING_CLEAN" : "DONE";
  }

  // Create/Requeue child pages:
  const newPages = await saveNewPages(links, indexed);

  return {
    newIndexedIds: newPages.map((p) => p.id),
    indexed,
    scrapeData,
    success: true,
  };
}

export async function saveNewPages(links: string[], indexed: Indexed & { foundFromIndex?: Indexed }) {
  if (links.length === 0) {
    return [];
  }
  const originIndexed = indexed.foundFromIndex || indexed;
  if (!originIndexed.doCrawl) {
    return [];
  }
  const maxDepth = originIndexed.scrapeOptions?.maxDepth !== undefined ? originIndexed.scrapeOptions.maxDepth : 3;
  if (indexed.depth >= maxDepth) {
    logger.info({ maxDepth, depth: indexed.depth }, "Max depth reached");
    return [];
  }
  let newPages = [];

  logger.info({ links: links.length, depth: indexed.depth }, "Found new links to scrape");

  // remove duplicates links by normalizedUrl:
  const uniqueLinks = links
    .map((l) => ({ url: l, normalizedUrl: normalizeUrl(l) }))
    .filter((l, index, self) => index === self.findIndex((t) => t.normalizedUrl === l.normalizedUrl));

  newPages = await db
    .insert(indexedTable)
    .values(
      uniqueLinks.map((link) => ({
        url: link.url,
        normalizedUrl: link.normalizedUrl,
        organizationId: originIndexed.organizationId,
        foundFromIndexId: originIndexed.id,
        depth: indexed.depth + 1,
        status: "PENDING",
        updatedAt: new Date(),
      }))
    )
    .onConflictDoUpdate({
      target: [indexedTable.organizationId, indexedTable.normalizedUrl],
      set: {
        foundFromIndexId: originIndexed.id,
        depth: indexed.depth + 1,
        status: "PENDING",
        updatedAt: new Date(),
      } as Partial<Indexed>,
      setWhere: and(eq(indexedTable.foundFromIndexId, originIndexed.id), eq(indexedTable.status, "OUTDATED")),
    })
    .returning();
  return newPages;
}

function hashContent(content: string) {
  return crypto.createHash("md5").update(content).digest("hex");
}

async function skipIndexed(indexed: Indexed, reason: string, canonicalUrl?: string) {
  await db
    .update(indexedTable)
    .set({
      status: "SKIPPED",
      skip: true,
      skipReason: reason,
      ...(canonicalUrl ? { canonicalUrl } : {}),
      indexedAt: new Date(),
    } as Indexed)
    .where(eq(indexedTable.id, indexed.id));

  return {
    newIndexedIds: [],
    success: true,
    scrapeData: null,
    indexed: null,
  };
}
