import mongoose from "mongoose";
import Category from "../../model/categoryModel.js";
import Cart from "../../model/cartModel.js";
import Wishlist from "../../model/wishlistModel.js";
import WishlistItem from "../../model/wishlistItemModel.js";
import Offer from "../../model/offersModel.js";

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
        let:  { pid: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$productId", "$$pid"] },
                  { $ne: ["$isDeleted", true] },
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
            as:    "v",
            in: {
              _id:       "$$v._id",
              price:     "$$v.priceDouble",
              mrp:       "$$v.mrpDouble",
              stock:     "$$v.stock",
              thumbnail: { $arrayElemAt: ["$$v.images", 0] },
              inStock:   { $gt: ["$$v.stock", 0] },
              options: {
                $arrayToObject: {
                  $filter: {
                    input: { $objectToArray: { $ifNull: ["$$v.options", {}] } },
                    as:    "opt",
                    cond: {
                      $and: [
                        { $not: [{ $regexMatch: { input: "$$opt.k", regex: "^[$_]" } }] },
                        { $eq: [{ $type: "$$opt.v" }, "string"] },
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

    const normalised = products.map(p => {
      const pid = String(p._id);
      const cid = String(p.categoryId);

      const applicableOffer = productOfferMap.get(pid) || categoryOfferMap.get(cid) || null;
      const offerPct        = applicableOffer ? Number(applicableOffer.offerPrecentage) : 0;

      return {
        ...p,
        _id: pid,
        variants: (p.variants || []).map(v => {
          let optionsObj = {};
          try {
            const raw = JSON.parse(JSON.stringify(v.options || {}));
            optionsObj = Object.fromEntries(
              Object.entries(raw).filter(([k, val]) =>
                !k.startsWith("$") && !k.startsWith("_") &&
                k !== "toObject"   && typeof val === "string"
              )
            );
          } catch { optionsObj = {}; }

          const vid           = v._id?.toString();
          const originalPrice = Number(v.price) || 0;
          const mrp           = Number(v.mrp)   || 0;
          const offerPrice    = offerPct > 0
            ? Math.round(originalPrice * (1 - offerPct / 100))
            : originalPrice;

          return {
            ...v,
            _id:          vid,
            options:      optionsObj,
            price:        offerPrice,
            originalPrice,
            mrp,
            offerPct,
            offerName:    applicableOffer?.offerName || "",
            wishlisted:   wishlistedVariantIds.has(vid) || wishlistedProductIds.has(pid),
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

  } catch (err) {
    console.error("Related products error:", err);
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
        isDeleted: { $ne: true },
        isActive:  { $ne: false },
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

    variants.forEach(v => {
      v._id       = v._id.toString();
      v.productId = v.productId.toString();
      v.price     = Number(v.price) || 0;
      v.mrp       = Number(v.mrp)   || 0;
    });

    // ── Apply offers to detail page variants ──
    const now = new Date();
    const activeOffers = await Offer.find({
      isActive:  true,
      isDeleted: false,
      startDate: { $lte: now },
      endDate:   { $gte: now },
    }).lean();

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

    const pid             = String(product._id);
    const cid             = String(product.categoryId);
    const applicableOffer = productOfferMap.get(pid) || categoryOfferMap.get(cid) || null;
    const offerPct        = applicableOffer ? Number(applicableOffer.offerPrecentage) : 0;

    // Mutate variants to inject offer pricing
    variants.forEach(v => {
      const originalPrice = v.price;
      v.originalPrice     = originalPrice;
      v.offerPct          = offerPct;
      v.offerName         = applicableOffer?.offerName || "";
      v.price             = offerPct > 0
        ? Math.round(originalPrice * (1 - offerPct / 100))
        : originalPrice;
    });

    let defaultVariant = variants[0] || null;
    if (variantQuery) {
      const found = variants.find(v => v._id === variantQuery);
      if (found) defaultVariant = found;
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
          (reviewDocs.reduce((s, r) => s + (r.rating || 0), 0) / reviewCount).toFixed(1)
        )
      : 0;

    const ratingDist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    reviewDocs.forEach(r => {
      const star = Math.round(r.rating);
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
        cartVariantIds = cart.items.map(i => i.variantId.toString());
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
    });

  } catch (err) {
    console.error("Product detail error:", err);
    next(err);
  }
};