import mongoose from "mongoose";
import Category from "../../model/categoryModel.js";
import Cart from "../../model/cartModel.js";
import Wishlist from "../../model/wishlistModel.js";
import WishlistItem from "../../model/wishlistItemModel.js";
import Offer from "../../model/offersModel.js";
import { formatImagePath } from "../../utils/imageUtils.js";

function buildPipeline({ excludeProductId, excludeVariantId, categoryId, brandName }) {
  return [
    {
      $match: {
        isDeleted:  { $ne: true },
        isActive:   { $ne: false },
        categoryId: new mongoose.Types.ObjectId(categoryId.toString()),
      },
    },
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
                  { $ne: ["$isDeleted", true] },
                  { $ne: ["$isActive", false] },
                  { $ne: ["$_id", new mongoose.Types.ObjectId(excludeVariantId)] },
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
        brandScore: {
          $cond: [{ $eq: ["$brandName", brandName] }, 0, 1],
        },
        productScore: {
          $cond: [
            { $eq: ["$_id", new mongoose.Types.ObjectId(excludeProductId)] },
            0, 1
          ],
        },
        variants: {
          $map: {
            input: "$variantDocs",
            as:    "variant",
            in: {
              _id:       "$$variant._id",
              price:     "$$variant.priceDouble",
              mrp:       "$$variant.mrpDouble",
              stock:     "$$variant.stock",
              thumbnail: { $arrayElemAt: ["$$variant.images", 0] },
              inStock:   { $gt: ["$$variant.stock", 0] },
              options: {
                $arrayToObject: {
                  $filter: {
                    input: { $objectToArray: { $ifNull: ["$$variant.options", {}] } },
                    as:    "option",
                    cond: {
                      $and: [
                        { $not: [{ $regexMatch: { input: "$$option.k", regex: "^[$_]" } }] },
                        { $eq: [{ $type: "$$option.v" }, "string"] },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    { $sort: { productScore: 1, brandScore: 1, createdAt: -1 } },
  ];
}

export const getRelatedProducts = async (req, res) => {
  try {
    const { id }           = req.params;
    const page             = Math.max(1, parseInt(req.query.page) || 1);
    const LIMIT            = 9;
    const currentVariantId = req.query.variant || "";

    if (!mongoose.Types.ObjectId.isValid(id))
      return res.json({ products: [], totalPages: 0 });

    const product = await mongoose.connection
      .collection("products")
      .findOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { projection: { brandName: 1, categoryId: 1 } }
      );

    if (!product) return res.json({ products: [], totalPages: 0 });

    const sessionUser = req.user || req.session?.user || null;

    const excludeVariantId = mongoose.Types.ObjectId.isValid(currentVariantId)
      ? currentVariantId
      : new mongoose.Types.ObjectId().toString();

    const pipeline = buildPipeline({
      excludeProductId: id,
      excludeVariantId,
      categoryId:       product.categoryId,
      brandName:        product.brandName,
    });

    const countResult = await mongoose.connection
      .collection("products")
      .aggregate([...pipeline, { $count: "total" }])
      .toArray();

    const total      = countResult[0]?.total || 0;
    const totalPages = Math.ceil(total / LIMIT);

    if (total === 0) {
      return res.json({
        products: [], totalPages: 0,
        currentPage: page, total: 0,
        isLoggedIn: !!(sessionUser),
      });
    }

    pipeline.push({ $skip:  (page - 1) * LIMIT });
    pipeline.push({ $limit: LIMIT });
    pipeline.push({
      $project: {
        _id: 1, productName: 1, brandName: 1,
        categoryName: 1, categoryId: 1, variants: 1,
      },
    });

    const products = await mongoose.connection
      .collection("products")
      .aggregate(pipeline)
      .toArray();

    // ── Wishlist ──
    const wishlistedVariantIds = new Set();
    const wishlistedProductIds = new Set();

    if (sessionUser?._id) {
      const wishlist = await Wishlist.findOne({
        userId: new mongoose.Types.ObjectId(sessionUser._id),
      }).lean();
      if (wishlist) {
        const items = await WishlistItem.find({ wishlistId: wishlist._id }).lean();
        items.forEach(item => {
          if (item.variantId) {
            wishlistedVariantIds.add(String(item.variantId));
          } else if (item.productId) {
            wishlistedProductIds.add(String(item.productId));
          }
        });
      }
    }

    // ── Fetch active offers ──
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

    const normalised = products.map(p => {
      const productId = String(p._id);
      const categoryId = String(p.categoryId);

      const pOffer = productOfferMap.get(productId);
      const cOffer = categoryOfferMap.get(categoryId);
      let applicableOffer = null;
      if (pOffer && cOffer) {
        applicableOffer = Number(pOffer.offerPrecentage) >= Number(cOffer.offerPrecentage) ? pOffer : cOffer;
      } else {
        applicableOffer = pOffer || cOffer || null;
      }
      const offerPercentage = applicableOffer ? Number(applicableOffer.offerPrecentage) : 0;

      return {
        ...p,
        _id: productId,
        variants: (p.variants || []).map(variant => {
          let optionsObj = {};
          try {
            const raw = JSON.parse(JSON.stringify(variant.options || {}));
            optionsObj = Object.fromEntries(
              Object.entries(raw).filter(([key, val]) =>
                !key.startsWith("$") && !key.startsWith("_") &&
                key !== "toObject"   && typeof val === "string"
              )
            );
          } catch { optionsObj = {}; }

          const variantId     = variant._id?.toString();
          const originalPrice = Number(variant.price) || 0;
          const mrp           = Number(variant.mrp)   || 0;
          const offerPrice    = offerPercentage > 0
            ? Math.round(originalPrice * (1 - offerPercentage / 100))
            : originalPrice;

          return {
            ...variant,
            _id:          variantId,
            options:      optionsObj,
            price:        offerPrice,
            originalPrice,
            mrp,
            offerPct:     offerPercentage,
            offerName:    applicableOffer?.offerName || "",
            wishlisted:   wishlistedVariantIds.has(variantId) || wishlistedProductIds.has(productId),
          };
        }),
      };
    });

    return res.json({
      products:    normalised,
      totalPages,
      currentPage: page,
      total,
      isLoggedIn:  !!(sessionUser),
    });

  } catch (error) {
    console.error("Related products error:", error);
    res.status(500).json({ products: [], totalPages: 0 });
  }
};

export const getProductDetailPage = async (req, res, next) => {
  try {
    const { id }       = req.params;
    const variantQuery = req.query.variant || "";

    if (!mongoose.Types.ObjectId.isValid(id)) return res.redirect("/user/list");

    const product = await mongoose.connection
      .collection("products")
      .findOne({
        _id:       new mongoose.Types.ObjectId(id),
        isDeleted: { $ne: true }
      });

    if (!product) return res.redirect("/user/list");

    product._id = product._id.toString();

    const category = await Category.findById(product.categoryId).lean();

    const variants = await mongoose.connection
      .collection("variants")
      .find({
        productId: new mongoose.Types.ObjectId(id),
        isDeleted: { $ne: true },
      })
      .toArray();

    variants.forEach(variant => {
      variant._id       = variant._id.toString();
      variant.productId = variant.productId.toString();
      variant.price     = Number(variant.price) || 0;
      variant.mrp       = Number(variant.mrp)   || 0;
      variant.images    = (variant.images || []).map(img => formatImagePath(img, "product"));
    });

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

    const productId       = String(product._id);
    const categoryId      = String(product.categoryId);
    const pOffer = productOfferMap.get(productId);
    const cOffer = categoryOfferMap.get(categoryId);
    let applicableOffer = null;
    if (pOffer && cOffer) {
      applicableOffer = Number(pOffer.offerPrecentage) >= Number(cOffer.offerPrecentage) ? pOffer : cOffer;
    } else {
      applicableOffer = pOffer || cOffer || null;
    }
    const offerPercentage = applicableOffer ? Number(applicableOffer.offerPrecentage) : 0;

    variants.forEach(variant => {
      const originalPrice = variant.price;
      variant.originalPrice     = originalPrice;
      variant.offerPct          = offerPercentage;
      variant.offerName         = applicableOffer?.offerName || "";
      variant.price             = offerPercentage > 0
        ? Math.round(originalPrice * (1 - offerPercentage / 100))
        : originalPrice;
    });

    const activeVariants = variants.filter((variant) => variant.isActive !== false);
    const isProductBlocked = product.isActive === false;
    const allVariantsBlocked = variants.length > 0 && activeVariants.length === 0;
    const isUnavailable = isProductBlocked || allVariantsBlocked || variants.length === 0;

    let unavailableMessage = "This product is currently unavailable.";
    if (isProductBlocked) {
      unavailableMessage =
        "This product is no longer available for purchase. Please browse similar items in our store.";
    } else if (allVariantsBlocked) {
      unavailableMessage =
        "All variants of this product are currently unavailable. Please check back later or explore alternatives.";
    } else if (variants.length === 0) {
      unavailableMessage = "No variants are available for this product at the moment.";
    }

    let defaultVariant = activeVariants[0] || variants[0] || null;
    if (variantQuery) {
      const found = variants.find((variant) => variant._id === variantQuery);
      if (found) defaultVariant = found;
    }
    if (defaultVariant?.isActive === false && activeVariants.length > 0) {
      defaultVariant = activeVariants[0];
    }

    const reviewDocs = await mongoose.connection
      .collection("reviews")
      .aggregate([
        { $match: { productId: new mongoose.Types.ObjectId(id) } },
        {
          $lookup: {
            from:         "users",
            localField:   "userId",
            foreignField: "_id",
            as:           "userInfo",
          },
        },
        {
          $addFields: {
            userName: { $ifNull: [{ $arrayElemAt: ["$userInfo.name", 0] }, "Customer"] },
          },
        },
        { $project: { userInfo: 0 } },
        { $sort:    { createdAt: -1 } },
      ])
      .toArray();

    const reviewCount = reviewDocs.length;
    const avgRating   = reviewCount > 0
      ? parseFloat(
          (reviewDocs.reduce((ratingSum, review) => ratingSum + (review.rating || 0), 0) / reviewCount).toFixed(1)
        )
      : 0;

    const ratingDist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    reviewDocs.forEach(review => {
      const star = Math.round(review.rating);
      if (ratingDist[star] !== undefined) ratingDist[star]++;
    });

    product.avgRating   = avgRating;
    product.reviewCount = reviewCount;
    product.ratingDist  = ratingDist;

    const sessionUser = req.user || req.session?.user || null;

    let cartVariantIds = [];
    if (sessionUser?._id) {
      const cart = await Cart.findOne({
        userId: new mongoose.Types.ObjectId(sessionUser._id),
      }).lean();
      if (cart?.items?.length)
        cartVariantIds = cart.items.map(item => item.variantId.toString());
    }

    let isWishlisted = false;
    if (sessionUser?._id) {
      const wishlist = await Wishlist.findOne({
        userId: new mongoose.Types.ObjectId(sessionUser._id),
      }).lean();
      if (wishlist) {
        if (defaultVariant?._id) {
          const byVariant = await WishlistItem.findOne({
            wishlistId: wishlist._id,
            productId:  new mongoose.Types.ObjectId(id),
            variantId:  defaultVariant._id,
          }).lean();
          if (byVariant) {
            isWishlisted = true;
          } else {
            const byProduct = await WishlistItem.findOne({
              wishlistId: wishlist._id,
              productId:  new mongoose.Types.ObjectId(id),
              $or: [{ variantId: null }, { variantId: { $exists: false } }],
            }).lean();
            isWishlisted = !!byProduct;
          }
        } else {
          const wishItem = await WishlistItem.findOne({
            wishlistId: wishlist._id,
            productId:  new mongoose.Types.ObjectId(id),
          }).lean();
          isWishlisted = !!wishItem;
        }
      }
    }

    res.render("user/product/detail", {
      user:          sessionUser,
      product,
      category,
      variants,
      defaultVariant,
      related:       [],
      reviews:       reviewDocs.slice(0, 5),
      activePage:    "list",
      cartVariantIds,
      isWishlisted,
      isUnavailable,
      unavailableMessage,
    });

  } catch (error) {
    console.error("Product detail error:", error);
    next(error);
  }
};