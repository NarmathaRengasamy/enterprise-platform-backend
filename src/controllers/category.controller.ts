import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { Category } from '../types/index.js';

export const createCategorySchema = z.object({
  body: z.object({
    id: z.string().optional(),
    name: z.string().min(1, 'Category name is required'),
    description: z.string().optional().default('General category item'),
    icon: z.string().optional().default('category'),
    color: z.string().optional().default('primary'),
  }),
});

export const updateCategorySchema = z.object({
  body: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
  }),
});

export const getCategories = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { search } = req.query;
    const categories = await store.getCategories(search as string);

    res.status(200).json({
      success: true,
      total: categories.length,
      data: categories,
    });
  } catch (error) {
    next(error);
  }
};

export const getCategoryById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const category = await store.getCategoryById(id);

    if (!category) {
      throw new AppError('Category not found', 404);
    }

    res.status(200).json({
      success: true,
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

export const createCategory = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id, name, description, icon, color } = req.body;
    const existingCats = await store.getCategories();
    const generatedId = id || `CAT-00${existingCats.length + 1}`;

    const existing = await store.getCategoryById(generatedId);
    if (existing) {
      throw new AppError('Category with this code/ID already exists', 400);
    }

    const newCategory: Category = {
      id: generatedId,
      name,
      description: description || 'General category item',
      productsCount: 0,
      updated: 'Just now',
      icon: icon || 'category',
      color: color || 'primary',
    };

    const created = await store.createCategory(newCategory);

    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: created,
    });
  } catch (error) {
    next(error);
  }
};

export const updateCategory = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const existing = await store.getCategoryById(id);
    if (!existing) {
      throw new AppError('Category not found', 404);
    }

    const updated = await store.updateCategory(id, {
      ...updates,
      updated: 'Just now',
    });

    res.status(200).json({
      success: true,
      message: 'Category updated successfully',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteCategory = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const success = await store.deleteCategory(id);

    if (!success) {
      throw new AppError('Category not found', 404);
    }

    res.status(200).json({
      success: true,
      message: 'Category deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

export const exportCategories = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const categories = await store.getCategories();
    const csv = "ID,Name,Description,ProductsCount\n" + categories.map(c => `"${c.id}","${c.name}","${c.description}",${c.productsCount || 0}`).join("\n");
    res.status(200).json({
      success: true,
      data: {
        categories,
        csv
      }
    });
  } catch (error) {
    next(error);
  }
};
