import mongoose from "mongoose";
import Product from "../../model/productModel.js";
import Category from "../../model/categoryModel.js";
import Variant from "../../model/variantModel.js";
import Wishlist from "../../model/wishlistModel.js";
import WishlistItem from "../../model/wishlistItemModel.js";
import Offer from "../../model/offersModel.js";

export const getMaxPrice = async (req, res) => {
  try {
    const variants = await Variant.find({ isDeleted: false, isActive: { $ne: false } }).select("price").lean();
    const prices   = variants.map(variant => Number(variant.price) || 0).filter(price => price > 0);
    const rawMax   = prices.length ? Math.max(...prices) : 100000;
    res.json({ maxPrice: rawMax + 2000 });
  } catch (error) {
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

    let existingWishlistItem = null;
    if (variantId) {
      existingWishlistItem = await WishlistItem.findOne({
        wishlistId: wishlist._id,
        productId,
        variantId,
      });
      if (!existingWishlistItem) {
        existingWishlistItem = await WishlistItem.findOne({
          wishlistId: wishlist._id,
          productId,
          $or: [{ variantId: null }, { variantId: { $exists: false } }],
        });
      }
    } else {
      existingWishlistItem = await WishlistItem.findOne({
        wishlistId: wishlist._id,
        productId,
      });
    }

    if (existingWishlistItem) {
      await WishlistItem.deleteOne({ _id: existingWishlistItem._id });
      return res.json({ success: true, wishlisted: false, message: "Removed from wishlist" });
    } else {
      await WishlistItem.create({
        wishlistId: wishlist._id,
        productId,
        variantId:  variantId || null,
      });
      return res.json({ success: true, wishlisted: true, message: "Added to wishlist!" });
    }
  } catch (error) {
    console.error("Wishlist toggle error:", error);
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

    const allVariants = await Variant.find({ isDeleted: false, isActive: { $ne: false } }).select("price").lean();
    const allPrices   = allVariants.map(variant => Number(variant.price) || 0).filter(price => price > 0);
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
          let:  { productId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$productId", "$$productId"] },
                    { $eq: ["$isDeleted", false] },
                    { $ne: ["$isActive", false] },
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
              as:    "variant",
              in: {
                _id:       "$$variant._id",
                price:     "$$variant.priceDouble",
                mrp:       "$$variant.mrpDouble",
                stock:     "$$variant.stock",
                options:   "$$variant.options",
                thumbnail: { $arrayElemAt: ["$$variant.images", 0] },
                inStock:   { $gt: ["$$variant.stock", 0] },
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
              as:    "variant",
              cond: {
                $and: [
                  ...(minVal !== null ? [{ $gte: ["$$variant.price", minVal] }] : []),
                  ...(maxVal !== null ? [{ $lte: ["$$variant.price", maxVal] }] : []),
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

    //Wishlist
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

    const now = new Date();
    const activeOffers = await Offer.find({
      isActive:  true,
      isDeleted: false,
      startDate: { $lte: now },
      endDate:   { $gte: now },
    }).lean();

    const productOfferMap  = new Map();
    const categoryOfferMap = new Map();
    activeOffers.forEach(offer => {
      const key = String(offer.refId);
      if (offer.offerType === "product") {
        if (!productOfferMap.has(key) || offer.offerPrecentage > productOfferMap.get(key).offerPrecentage)
          productOfferMap.set(key, offer);
      } else if (offer.offerType === "category") {
        if (!categoryOfferMap.has(key) || offer.offerPrecentage > categoryOfferMap.get(key).offerPrecentage)
          categoryOfferMap.set(key, offer);
      }
    });

    const productsWithWishlist = products.map(product => {
      const productId = String(product._id);
      const categoryId = String(product.categoryId);

      const pOffer = productOfferMap.get(productId);
      const cOffer = categoryOfferMap.get(categoryId);
      let applicableOffer = null;
      if (pOffer && cOffer) {
        applicableOffer = Number(pOffer.offerPrecentage) >= Number(cOffer.offerPrecentage) ? pOffer : cOffer;
      } else {
        applicableOffer = pOffer || cOffer || null;
      }
      const offerPercentage = applicableOffer ? Number(applicableOffer.offerPrecentage) : 0;

      let variants = (product.variants || []).map(variant => {
        let optionsObj = {};
        if (variant.options instanceof Map) {
          variant.options.forEach((val, key) => { optionsObj[key] = val; });
        } else if (variant.options && typeof variant.options === "object") {
          optionsObj = Object.fromEntries(
            Object.entries(variant.options).filter(
              ([key]) => !key.startsWith("$") && !key.startsWith("_") && key !== "toObject"
            )
          );
        }
        const variantId     = String(variant._id);
        const originalPrice = Number(variant.price) || 0;
        const mrp           = Number(variant.mrp)   || 0;

        const offerPrice = offerPercentage > 0
          ? Math.round(originalPrice * (1 - offerPercentage / 100))
          : originalPrice;

        return {
          ...variant,
          price:         offerPrice,
          originalPrice,
          mrp,
          options:       optionsObj,
          offerPct:      offerPercentage,
          offerName:     applicableOffer?.offerName || "",
          wishlisted:    wishlistedVariantIds.has(variantId) || wishlistedProductIds.has(productId),
        };
      });

      if (sort === "price_asc") {
        variants.sort((a, b) => a.price - b.price);
      } else if (sort === "price_desc") {
        variants.sort((a, b) => b.price - a.price);
      }

      return { ...product, variants };
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

  } catch (error) {
    console.error("Shop error:", error);
    next(error);
  }
};