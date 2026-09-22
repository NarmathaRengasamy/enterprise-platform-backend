import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { createLogger } from '../utils/logger.js';
import { toAppError } from '../utils/error.util.js';
import { generateId, getPageParams, ok, paginated } from '../utils/response.util.js';

const log = createLogger('KnowledgeController');
const WORDS_PER_MINUTE = 200;

/** Seed rows store views as "2,420"; newer rows store a number. */
const parseViews = (value: unknown): number =>
  typeof value === 'number' ? value : parseInt(String(value ?? '0').replace(/,/g, ''), 10) || 0;

/** Derived from the content instead of the hardcoded '3 min read'. */
const readTimeOf = (content: string): string => {
  const words = String(content ?? '').trim().split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.ceil(words / WORDS_PER_MINUTE))} min read`;
};
import { Article, Collection } from '../types/index.js';

export const createArticleSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Title is required'),
    category: z.string().min(1, 'Category is required'),
    categoryColor: z.string().optional().default('primary'),
    readTime: z.string().optional().default('3 min read'),
    visibility: z.enum(['Public article', 'Pinned', 'Internal & Public', 'Internal only']).optional().default('Public article'),
    icon: z.string().optional().default('description'),
    content: z.string().min(1, 'Article content is required'),
  }),
});

export const updateArticleSchema = z.object({
  body: z.object({
    title: z.string().optional(),
    category: z.string().optional(),
    categoryColor: z.string().optional(),
    readTime: z.string().optional(),
    visibility: z.enum(['Public article', 'Pinned', 'Internal & Public', 'Internal only']).optional(),
    icon: z.string().optional(),
    content: z.string().optional(),
  }),
});

export const createCollectionSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Collection title is required'),
    description: z.string().min(1, 'Collection description is required'),
    icon: z.string().optional().default('folder'),
    color: z.string().optional().default('primary'),
  }),
});

export const getArticles = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { page, limit, skip } = getPageParams(req);
    const { category, search, sortBy, sortOrder } = req.query;
    let articles = await store.getArticles({
      category: category as string,
      search: search as string,
    });

    if (sortBy === 'title') {
      const dir = sortOrder === 'desc' ? -1 : 1;
      articles = [...articles].sort((a, b) => a.title.localeCompare(b.title) * dir);
    } else if (sortBy === 'views') {
      const dir = sortOrder === 'asc' ? 1 : -1;
      articles = [...articles].sort((a, b) => (parseViews(a.views) - parseViews(b.views)) * dir);
    }

    res.status(200).json(
      paginated(articles.slice(skip, skip + limit), articles.length, page, limit)
    );
  } catch (error) {
    next(error);
  }
};

export const bulkDeleteArticlesSchema = z.object({
  body: z.object({ ids: z.array(z.string()).min(1, 'ids must not be empty') }),
});

export const bulkDeleteArticles = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const ids = req.body.ids as string[];
    let deleted = 0;
    for (const id of ids) {
      if (await store.deleteArticle(id)) deleted += 1;
    }
    log.log(`Bulk deleted ${deleted} article(s)`);
    res
      .status(200)
      .json(ok({ deleted, notFound: ids.length - deleted }, 'Bulk delete completed'));
  } catch (error) {
    next(toAppError(error, 'Could not complete the bulk delete', log));
  }
};

/** Counts a read. Separate so a view never rewrites the whole document. */
export const recordArticleView = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const article = await store.getArticleById(req.params.id);
    if (!article) throw new AppError('Article not found', 404);

    const views = parseViews(article.views) + 1;
    await store.updateArticle(req.params.id, { views } as any);
    res.status(200).json(ok({ id: req.params.id, views }));
  } catch (error) {
    next(toAppError(error, `Could not record a view for ${req.params.id}`, log));
  }
};

export const getKnowledgeStats = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const articles = await store.getArticles();
    res.status(200).json(
      ok({
        totalArticles: articles.length,
        totalViews: articles.reduce((sum, a) => sum + parseViews(a.views), 0),
        activeCategories: new Set(articles.map((a) => a.category)).size,
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not compute knowledge statistics', log));
  }
};

export const getArticleById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const article = await store.getArticleById(id);

    if (!article) {
      throw new AppError('Article not found', 404);
    }

    res.status(200).json({
      success: true,
      data: article,
    });
  } catch (error) {
    next(error);
  }
};

export const createArticle = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { title, category, categoryColor, readTime, visibility, icon, content } = req.body;

    const newArticle: Article = {
      id: `art-${Date.now()}`,
      title,
      category,
      categoryColor: categoryColor || 'primary',
      /* Derived from the content unless the caller insists on a value. */
      readTime: readTime || readTimeOf(content ?? ''),
      visibility: visibility || 'Public article',
      updated: 'Just now',
      icon: icon || 'article',
      iconBg: 'bg-primary-container/10 text-primary',
      catBg: 'bg-surface-container text-primary',
      views: '0',
      content,
    };

    const created = await store.createArticle(newArticle);

    res.status(201).json({
      success: true,
      message: 'Article created successfully',
      data: created,
    });
  } catch (error) {
    next(error);
  }
};

export const updateArticle = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const existing = await store.getArticleById(id);
    if (!existing) {
      throw new AppError('Article not found', 404);
    }

    const updated = await store.updateArticle(id, {
      ...updates,
      updated: 'Just now',
    });

    res.status(200).json({
      success: true,
      message: 'Article updated successfully',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteArticle = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const success = await store.deleteArticle(id);

    if (!success) {
      throw new AppError('Article not found', 404);
    }

    res.status(200).json({
      success: true,
      message: 'Article deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

export const getCollections = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const collections = await store.getCollections();

    res.status(200).json({
      success: true,
      total: collections.length,
      data: collections,
    });
  } catch (error) {
    next(error);
  }
};

export const createCollection = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { title, description, icon, color } = req.body;

    const newCollection: Collection = {
      id: `col-${Date.now()}`,
      title,
      description,
      articleCount: 0,
      icon: icon || 'folder',
      color: color || 'primary',
    };

    const created = await store.createCollection(newCollection);

    res.status(201).json({
      success: true,
      message: 'Collection created successfully',
      data: created,
    });
  } catch (error) {
    next(error);
  }
};

export const generateCatalogMarkdown = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const products = await store.getProducts();
    const categories = await store.getCategories();

    let markdown = `# Perfox / OmniFlow Knowledge Catalog\nGenerated at: ${new Date().toISOString()}\n\n`;
    markdown += `## Categories (${categories.length})\n`;
    categories.forEach((c) => {
      markdown += `- **${c.name}** (${c.id}): ${c.description} - ${c.productsCount} products\n`;
    });

    markdown += `\n## Products (${products.length})\n`;
    products.forEach((p) => {
      markdown += `\n### ${p.name} [SKU: ${p.sku}]\n`;
      markdown += `- **Category**: ${p.category}\n`;
      markdown += `- **Price**: $${p.price} | Stock: ${p.stock} (${p.stockStatus})\n`;
      markdown += `- **Description**: ${p.description}\n`;
      if (p.variants && p.variants.length > 0) {
        markdown += `- **Variants**:\n`;
        p.variants.forEach((v) => {
          markdown += `  - ${v.option}: ${v.value} - $${v.price} (${v.stock})\n`;
        });
      }
    });

    res.status(200).json({
      success: true,
      message: 'Catalog markdown generated successfully for LLM retrieval',
      data: {
        itemCount: products.length,
        generatedAt: new Date().toISOString(),
        markdown,
      },
    });
  } catch (error) {
    next(error);
  }
};
