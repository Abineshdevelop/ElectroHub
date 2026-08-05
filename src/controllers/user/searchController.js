import mongoose     from "mongoose";
import Product      from "../../model/productModel.js";
import Category     from "../../model/categoryModel.js";
import Cart         from "../../model/cartModel.js";
import Wishlist     from "../../model/wishlistModel.js";
import WishlistItem from "../../model/wishlistItemModel.js";

export const getNavCounts = async (req, res) => {
  try {
    const userId = req.session.user?._id;
    if (!userId) return res.json({ cartCount: 0, wishlistCount: 0 });

    const wishlist = await Wishlist.findOne({ userId }).lean();

    const [cart, wishlistCount] = await Promise.all([
      Cart.findOne({ userId }).lean(),
      wishlist
        ? WishlistItem.countDocuments({ wishlistId: wishlist._id })
        : Promise.resolve(0),
    ]);

    res.json({
      cartCount:     cart?.items?.length || 0,
      wishlistCount,
    });
  } catch (error) {
    console.error('getNavCounts error:', error);
    res.json({ cartCount: 0, wishlistCount: 0 });
  }
};

export const getSearchSuggestions = async (req, res) => {
  try {
    const searchQuery = (req.query.q || '').trim();
    if (!searchQuery || searchQuery.length < 2) {
      return res.json({ categories: [], products: [], variants: [] });
    }

    // Categories matching query
    const rawCategories = await Category.find({
      isActive:     { $ne: false },
      isDeleted:    false,
      categoryName: { $regex: searchQuery, $options: 'i' },
    }).limit(4).lean();

    const categories = await Promise.all(
      rawCategories.map(async (category) => ({
        _id:          category._id,
        categoryName: category.categoryName,
        productCount: await Product.countDocuments({
          categoryId: category._id,
          isActive:   { $ne: false },
          isDeleted:  false,
        }),
      }))
    );

    // Products matching query, populated with their lowest variant price and variant thumbnail
    const products = await Product.aggregate([
      {
        $match: {
          isDeleted: false,
          isActive:  { $ne: false },
          $or: [
            { productName: { $regex: searchQuery, $options: 'i' } },
            { brandName:   { $regex: searchQuery, $options: 'i' } },
          ],
        },
      },
      {
        $lookup: {
          from:         'categories',
          localField:   'categoryId',
          foreignField: '_id',
          as:           'categoryData',
        },
      },
      {
        $lookup: {
          from:         'variants',
          let:          { productId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$productId', '$$productId'] },
                    { $eq: ['$isDeleted', false] },
                    { $ne: ['$isActive', false] }
                  ]
                }
              }
            }
          ],
          as:           'activeVariants',
        }
      },
      { $match: { 'activeVariants.0': { $exists: true } } },
      {
        $addFields: {
          categoryName: { $arrayElemAt: ['$categoryData.categoryName', 0] },
          thumbnail:    { $arrayElemAt: [{ $arrayElemAt: ['$activeVariants.images', 0] }, 0] },
          price:        { $min: '$activeVariants.price' },
        },
      },
      { $sort:  { productName: 1 } },
      { $limit: 8 },
      {
        $project: {
          productName:  1,
          brandName:    1,
          categoryName: 1,
          thumbnail:    1,
          price:        1,
        },
      },
    ]);

    res.json({ categories, products, variants: products });
  } catch (error) {
    console.error('searchSuggestions error:', error);
    res.json({ categories: [], products: [], variants: [] });
  }
};

// ── GET /user/nav-categories ──────────────────────────────────────────────
export const getNavCategories = async (req, res) => {
  try {
    const activeCategories = await Category.aggregate([
      { $match: { isActive: { $ne: false }, isDeleted: false } },
      {
        $lookup: {
          from:         'products',
          localField:   '_id',
          foreignField: 'categoryId',
          as:           'productsList',
        },
      },
      {
        $addFields: {
          productCount: {
            $size: {
              $filter: {
                input: '$productsList',
                as:    'product',
                cond: {
                  $and: [
                    { $ne: ['$$product.isActive', false] },
                    { $eq: ['$$product.isDeleted', false] },
                  ],
                },
              },
            },
          },
        },
      },
      { $sort:    { categoryName: 1 } },
      { $project: { categoryName: 1, productCount: 1 } },
    ]);
    res.json(activeCategories);
  } catch (error) {
    console.error('getNavCategories error:', error);
    res.json([]);
  }
};

// ── GET /user/nav-category-products ──────────────────────────────────────
export const getNavCategoryProducts = async (req, res) => {
  try {
    const { category, limit = 8 } = req.query;
    const match = { isActive: { $ne: false }, isDeleted: false };
    if (category) {
      match.categoryId = new mongoose.Types.ObjectId(String(category));
    }

    const products = await Product.aggregate([
      { $match: match },
      {
        $lookup: {
          from: 'variants',
          let: { productId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$productId', '$$productId'] },
                    { $eq: ['$isDeleted', false] },
                    { $ne: ['$isActive', false] }
                  ]
                }
              }
            }
          ],
          as: 'activeVariants'
        }
      },
      { $match: { 'activeVariants.0': { $exists: true } } },
      { $limit: Number(limit) },
      {
        $project: {
          name:      '$productName',
          thumbnail: { $arrayElemAt: [{ $arrayElemAt: ['$activeVariants.images', 0] }, 0] },
          price:     { $min: '$activeVariants.price' },
        },
      },
    ]);

    res.json({ products });
  } catch (error) {
    console.error('getNavCategoryProducts error:', error);
    res.json({ products: [] });
  }
};