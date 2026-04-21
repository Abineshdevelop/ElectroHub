import mongoose from "mongoose";
import Product from "../../model/productModel.js";
import Category from "../../model/categoryModel.js";
import Variant from "../../model/variantModel.js";
import Wishlist from "../../model/wishlistModel.js";
import WishlistItem from "../../model/wishlistItemModel.js";
import Offer from "../../model/offersModel.js";

export const getMaxPrice = async (req, res) => {
  try {
    const variants = await Variant.find({ isDeleted: false }).select("price").lean();
    const prices   = variants.map(v => Number(v.price) || 0).filter(p => p > 0);
    const rawMax   = prices.length ? Math.max(...prices) : 100000;
    res.json({ maxPrice: rawMax + 2000 });
  } catch (err) {
    res.json({ maxPrice: 102000 });
  }
};

export const toggleWishlist = async (req, res) => {
  try {
    const sessionUser = req.user || req.session?.user || null;
    const userId      = sessionUser?._id;

    if (!userId)
      return res.status(401).json({ success: false, message: "Login required" });

    const { productId, variantId } = req.body;
    if (!productId)
      return res.status(400).json({ success: false, message: "productId required" });

    let wishlist = await Wishlist.findOne({ userId });
    if (!wishlist) wishlist = await Wishlist.create({ userId });

    let existing = null;
    if (variantId) {
      existing = await WishlistItem.findOne({
        wishlistId: wishlist._id,
        productId,
        variantId,
      });
      if (!existing) {
        existing = await WishlistItem.findOne({
          wishlistId: wishlist._id,
          productId,
          $or: [{ variantId: null }, { variantId: { $exists: false } }],
        });
      }
    } else {
      existing = await WishlistItem.findOne({
        wishlistId: wishlist._id,
        productId,
      });
    }

    if (existing) {
      await WishlistItem.deleteOne({ _id: existing._id });
      return res.json({ success: true, wishlisted: false, message: "Removed from wishlist" });
    } else {
      await WishlistItem.create({
        wishlistId: wishlist._id,
        productId,
        variantId:  variantId || null,
      });
      return res.json({ success: true, wishlisted: true, message: "Added to wishlist!" });
    }
  } catch (err) {
    console.error("Wishlist toggle error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getProductListingPage = async (req, res, next) => {
  try {
    const {
      search   = "",
      sort     = "default",
      category = "",
      brand    = "",
      page     = 1,
      minPrice = "",
      maxPrice = "",
    } = req.query;

    const LIMIT       = 9;
    const currentPage = Math.max(1, parseInt(page));

    const allVariants = await Variant.find({ isDeleted: false }).select("price").lean();
    const allPrices   = allVariants.map(v => Number(v.price) || 0).filter(p => p > 0);
    const rawMax      = allPrices.length ? Math.max(...allPrices) : 100000;
    const maxPriceCap = rawMax + 2000;

    const minVal = (minPrice !== "" && !isNaN(Number(minPrice))) ? Number(minPrice) : null;
    const maxVal = (maxPrice !== "" && !isNaN(Number(maxPrice))) ? Number(maxPrice) : null;

    const matchFilter = { isDeleted: false, isActive: true };
    if (category && mongoose.Types.ObjectId.isValid(category)) {
      matchFilter.categoryId = new mongoose.Types.ObjectId(category);
    }
    if (brand && brand.trim()) {
      matchFilter.brandName = { $regex: `^${brand.trim()}$`, $options: "i" };
    }
    if (search.trim()) {
      matchFilter.$or = [
        { productName: { $regex: search.trim(), $options: "i" } },
        { brandName:   { $regex: search.trim(), $options: "i" } },
      ];
    }

    const pipeline = [
      { $match: matchFilter },
      {
        $lookup: {
          from: "variants",
          let:  { pid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$productId", "$$pid"] },
                    { $eq: ["$isDeleted", false] },
                  ],
                },
              },
            },
            {
              $addFields: {
                priceDouble: { $toDouble: { $ifNull: ["$price", 0] } },
                mrpDouble:   { $toDouble: { $ifNull: ["$mrp",   0] } },
              },
            },
            { $sort: { priceDouble: 1 } },
          ],
          as: "variantDocs",
        },
      },
      { $match: { "variantDocs.0": { $exists: true } } },
      {
        $lookup: {
          from:         "categories",
          localField:   "categoryId",
          foreignField: "_id",
          as:           "categoryData",
        },
      },
      {
        $addFields: {
          categoryName: { $arrayElemAt: ["$categoryData.categoryName", 0] },
          categoryId:   "$categoryId",
          variants: {
            $map: {
              input: "$variantDocs",
              as:    "v",
              in: {
                _id:       "$$v._id",
                price:     "$$v.priceDouble",
                mrp:       "$$v.mrpDouble",
                stock:     "$$v.stock",
                options:   "$$v.options",
                thumbnail: { $arrayElemAt: ["$$v.images", 0] },
                inStock:   { $gt: ["$$v.stock", 0] },
              },
            },
          },
          lowestPrice: {
            $toDouble: {
              $ifNull: [{ $arrayElemAt: ["$variantDocs.priceDouble", 0] }, 0],
            },
          },
          highestPrice: {
            $toDouble: {
              $ifNull: [{ $arrayElemAt: ["$variantDocs.priceDouble", -1] }, 0],
            },
          },
          inStock: { $gt: [{ $sum: "$variantDocs.stock" }, 0] },
        },
      },
    ];

    if (minVal !== null || maxVal !== null) {
      pipeline.push({
        $addFields: {
          variants: {
            $filter: {
              input: "$variants",
              as:    "v",
              cond: {
                $and: [
                  ...(minVal !== null ? [{ $gte: ["$$v.price", minVal] }] : []),
                  ...(maxVal !== null ? [{ $lte: ["$$v.price", maxVal] }] : []),
                ],
              },
            },
          },
        },
      });
      pipeline.push({ $match: { "variants.0": { $exists: true } } });
      pipeline.push({
        $addFields: {
          lowestPrice:  { $min: "$variants.price" },
          highestPrice: { $max: "$variants.price" },
        },
      });
    }

    const sortStage = {};
    if      (sort === "price_asc")  sortStage.lowestPrice  = 1;
    else if (sort === "price_desc") sortStage.highestPrice = -1;
    else if (sort === "az")         sortStage.productName  = 1;
    else if (sort === "za")         sortStage.productName  = -1;
    else                            sortStage.createdAt    = -1;
    pipeline.push({ $sort: sortStage });

    const countResult   = await Product.aggregate([...pipeline, { $count: "total" }]);
    const totalProducts = countResult[0]?.total || 0;
    const totalPages    = Math.ceil(totalProducts / LIMIT);

    pipeline.push({ $skip:  (currentPage - 1) * LIMIT });
    pipeline.push({ $limit: LIMIT });

    const products = await Product.aggregate(pipeline);

    const categories = await Category.find({ isDeleted: false, isActive: true }).lean();
    const brandFilter = { isDeleted: false, isActive: true };
    if (category && mongoose.Types.ObjectId.isValid(category)) {
      brandFilter.categoryId = new mongoose.Types.ObjectId(category);
    }
    const brands = await Product.distinct("brandName", brandFilter);

    // ── Wishlist ──
    const wishlistedVariantIds = new Set();
    const wishlistedProductIds = new Set();
    const sessionUser = req.user || req.session?.user || null;

    if (sessionUser?._id) {
      const wishlist = await Wishlist.findOne({ userId: sessionUser._id }).lean();
      if (wishlist) {
        const items = await WishlistItem.find({ wishlistId: wishlist._id }).lean();
        items.forEach(item => {
          if (item.variantId) {
            wishlistedVariantIds.add(String(item.variantId));
          } else {
            if (item.productId) wishlistedProductIds.add(String(item.productId));
          }
        });
      }
    }

    // ── Fetch all active offers ──
    const now = new Date();
    const activeOffers = await Offer.find({
      isActive:  true,
      isDeleted: false,
      startDate: { $lte: now },
      endDate:   { $gte: now },
    }).lean();

    // ── Build offer maps: key = string of refId ──
    const productOfferMap  = new Map();
    const categoryOfferMap = new Map();
    activeOffers.forEach(o => {
      const key = String(o.refId);
      if (o.offerType === "product") {
        if (!productOfferMap.has(key) || o.offerPrecentage > productOfferMap.get(key).offerPrecentage)
          productOfferMap.set(key, o);
      } else if (o.offerType === "category") {
        if (!categoryOfferMap.has(key) || o.offerPrecentage > categoryOfferMap.get(key).offerPrecentage)
          categoryOfferMap.set(key, o);
      }
    });

    const productsWithWishlist = products.map(p => {
      // ✅ convert both to string for reliable comparison
      const pid = String(p._id);
      const cid = String(p.categoryId);

      const applicableOffer = productOfferMap.get(pid) || categoryOfferMap.get(cid) || null;
      const offerPct        = applicableOffer ? Number(applicableOffer.offerPrecentage) : 0;

      let variants = (p.variants || []).map(v => {
        let optionsObj = {};
        if (v.options instanceof Map) {
          v.options.forEach((val, key) => { optionsObj[key] = val; });
        } else if (v.options && typeof v.options === "object") {
          optionsObj = Object.fromEntries(
            Object.entries(v.options).filter(
              ([k]) => !k.startsWith("$") && !k.startsWith("_") && k !== "toObject"
            )
          );
        }
        const vid           = String(v._id);
        const originalPrice = Number(v.price) || 0;
        const mrp           = Number(v.mrp)   || 0;

        const offerPrice = offerPct > 0
          ? Math.round(originalPrice * (1 - offerPct / 100))
          : originalPrice;

        return {
          ...v,
          price:         offerPrice,
          originalPrice,
          mrp,
          options:       optionsObj,
          offerPct,
          offerName:     applicableOffer?.offerName || "",
          wishlisted:    wishlistedVariantIds.has(vid) || wishlistedProductIds.has(pid),
        };
      });

      if (sort === "price_asc") {
        variants.sort((a, b) => a.price - b.price);
      } else if (sort === "price_desc") {
        variants.sort((a, b) => b.price - a.price);
      }

      return { ...p, variants };
    });

    if (req.headers["x-requested-with"] === "XMLHttpRequest") {
      return res.json({
        products:      productsWithWishlist,
        totalProducts,
        totalPages,
        currentPage,
        maxPriceCap,
        brands,
        isLoggedIn:    !!(sessionUser),
      });
    }

    res.render("user/product/list", {
      user:         sessionUser,
      products:     productsWithWishlist,
      categories,
      brands,
      maxPriceCap,
      currentPage,
      totalPages,
      totalProducts,
      search,
      sort,
      category,
      brand,
      minPrice,
      maxPrice,
      activePage:   "list",
      isLoggedIn:   !!(sessionUser),
    });

  } catch (err) {
    console.error("Shop error:", err);
    next(err);
  }
};