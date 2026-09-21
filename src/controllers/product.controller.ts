import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { Product } from '../types/index.js';

export const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Product name is required'),
    shortName: z.string().optional(),
    sku: z.string().min(1, 'SKU is required'),
    category: z.string().min(1, 'Category is required'),
    categoryCode: z.string().min(1, 'Category code is required'),
    price: z.number().positive('Price must be greater than 0'),
    originalPrice: z.number().optional(),
    stock: z.number().min(0, 'Stock cannot be negative'),
    stockStatus: z.enum(['In Stock', 'Low Stock', 'Out of Stock', 'Sold Out', 'Limited']).optional(),
    committed: z.number().optional().default(0),
    reorderPoint: z.number().optional().default(10),
    margin: z.string().optional().default('50.0%'),
    discount: z.string().optional(),
    image: z.string().optional(),
    gallery: z.array(z.object({
      id: z.number(),
      label: z.string(),
      src: z.string()
    })).optional().default([]),
    description: z.string().min(1, 'Description is required'),
    variants: z.array(z.any()).optional().default([]),
    videos: z.array(z.any()).optional().default([]),
  }),
});

export const updateProductSchema = z.object({
  body: z.object({
    name: z.string().optional(),
    shortName: z.string().optional(),
    sku: z.string().optional(),
    category: z.string().optional(),
    categoryCode: z.string().optional(),
    price: z.number().optional(),
    originalPrice: z.number().optional(),
    stock: z.number().optional(),
    stockStatus: z.enum(['In Stock', 'Low Stock', 'Out of Stock', 'Sold Out', 'Limited']).optional(),
    committed: z.number().optional(),
    reorderPoint: z.number().optional(),
    margin: z.string().optional(),
    discount: z.string().optional(),
    image: z.string().optional(),
    gallery: z.array(z.object({
      id: z.number(),
      label: z.string(),
      src: z.string()
    })).optional(),
    description: z.string().optional(),
    variants: z.array(z.any()).optional(),
    videos: z.array(z.any()).optional(),
  }),
});

export const getProducts = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { category, status, search, page = '1', limit = '50' } = req.query;

    const products = await store.getProducts({
      category: category as string,
      status: status as string,
      search: search as string,
    });

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const total = products.length;
    const startIndex = (pageNum - 1) * limitNum;
    const paginated = products.slice(startIndex, startIndex + limitNum);

    res.status(200).json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
      data: paginated,
    });
  } catch (error) {
    next(error);
  }
};

export const getProductById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const product = await store.getProductById(id);

    if (!product) {
      throw new AppError('Product not found', 404);
    }

    res.status(200).json({
      success: true,
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

export const createProduct = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const body = req.body;
    const stockStatus = body.stockStatus || (body.stock > 10 ? 'In Stock' : body.stock > 0 ? 'Low Stock' : 'Sold Out');
    const existingProducts = await store.getProducts();
    
    const newProduct: Product = {
      id: body.sku ? body.sku : `PRD${String(existingProducts.length + 1).padStart(3, '0')}`,
      ...body,
      stockStatus,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const created = await store.createProduct(newProduct);

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: created,
    });
  } catch (error) {
    next(error);
  }
};

export const updateProduct = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const existing = await store.getProductById(id);
    if (!existing) {
      throw new AppError('Product not found', 404);
    }

    const updated = await store.updateProduct(id, updates);

    res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteProduct = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const success = await store.deleteProduct(id);

    if (!success) {
      throw new AppError('Product not found', 404);
    }

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};
