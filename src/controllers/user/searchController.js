import mongoose     from "mongoose";
import Product      from "../../model/productModel.js";
import Category     from "../../model/categoryModel.js";
import Cart         from "../../model/cartModel.js";
import Wishlist     from "../../model/wishlistModel.js";
import WishlistItem from "../../model/wishlistItemModel.js";

// ── GET /user/nav-counts ──────────────────────────────────────────────────
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
  } catch (err) {
    console.error('getNavCounts error:', err);
    res.json({ cartCount: 0, wishlistCount: 0 });
  }
};

// ── GET /user/search-suggestions ─────────────────────────────────────────
export const getSearchSuggestions = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ categories: [], products: [], variants: [] });

    // Categories matching query
    const rawCats = await Category.find({
      isActive:     true,
      isDeleted:    false,
      categoryName: { $regex: q, $options: 'i' },
    }).limit(4).lean();

    const categories = await Promise.all(
      rawCats.map(async (c) => ({
        _id:          c._id,
        categoryName: c.categoryName,
        productCount: await Product.countDocuments({
          categoryId: c._id,
          isActive:   true,
          isDeleted:  false,
        }),
      }))
    );

    // Products matching query
    const products = await Product.aggregate([
      {
        $match: {
          isDeleted: false,
          isActive:  true,
          $or: [
            { productName: { $regex: q, $options: 'i' } },
            { brandName:   { $regex: q, $options: 'i' } },
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
        $addFields: {
          categoryName: { $arrayElemAt: ['$categoryData.categoryName', 0] },
          thumbnail:    { $arrayElemAt: [{ $arrayElemAt: ['$variants.images', 0] }, 0] },
          price:        { $min: '$variants.price' },
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

  } catch (err) {
    console.error('searchSuggestions error:', err);
    res.json({ categories: [], products: [], variants: [] });
  }
};

// ── GET /user/nav-categories ──────────────────────────────────────────────
export const getNavCategories = async (req, res) => {
  try {
    const cats = await Category.aggregate([
      { $match: { isActive: true, isDeleted: false } },
      {
        $lookup: {
          from:         'products',
          localField:   '_id',
          foreignField: 'categoryId',
          as:           'prods',
        },
      },
      {
        $addFields: {
          productCount: {
            $size: {
              $filter: {
                input: '$prods',
                as:    'p',
                cond: {
                  $and: [
                    { $eq: ['$$p.isActive',  true]  },
                    { $eq: ['$$p.isDeleted', false] },
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
    res.json(cats);
  } catch (err) {
    console.error('getNavCategories error:', err);
    res.json([]);
  }
};

// ── GET /user/nav-category-products ──────────────────────────────────────
export const getNavCategoryProducts = async (req, res) => {
  try {
    const { category, limit = 8 } = req.query;
    const match = { isActive: true, isDeleted: false };
    if (category) {
      match.categoryId = new mongoose.Types.ObjectId(String(category));
    }

    const products = await Product.aggregate([
      { $match: match },
      { $limit: Number(limit) },
      {
        $project: {
          name:      '$productName',
          thumbnail: { $arrayElemAt: [{ $arrayElemAt: ['$variants.images', 0] }, 0] },
          price:     { $min: '$variants.price' },
        },
      },
    ]);

    res.json({ products });
  } catch (err) {
    console.error('getNavCategoryProducts error:', err);
    res.json({ products: [] });
  }
  
};