import mongoose from "mongoose";
import Banner from "../../model/bannerModel.js";
import Category from "../../model/categoryModel.js";
import Product from "../../model/productModel.js";
import Variant from "../../model/variantModel.js";
import Offer from "../../model/offersModel.js";
import Wishlist from "../../model/wishlistModel.js";
import WishlistItem from "../../model/wishlistItemModel.js";

export async function loadHomePage(req, res, next) {
  try {
    const sessionUser = req.user
    const now = new Date();

    // Fetch all data in parallel
    const [categories, bannersRaw, activeOffers, rawProducts, recentProducts] = await Promise.all([
      Category.find({ isDeleted: false, isActive: true }).lean(),
      Banner.find({ isDeleted: false, status: "active" }).populate("offerId").lean(),
      Offer.find({ isActive: true, isDeleted: false, startDate: { $lte: now }, endDate: { $gte: now } }).lean(),
      Product.find({ isDeleted: false, isActive: true }).lean(),
      Product.find({ isDeleted: false, isActive: true }).sort({ createdAt: -1 }).limit(12).lean(),
    ]);

    const banners = [];
    for (const b of bannersRaw) {
      if (b.offerId) {
        const offer = b.offerId;
        if (offer.offerType === "product") {
          const prod = await Product.findOne({ _id: offer.refId, isDeleted: false });
          b.redirectType = "product";
          b.redirectValue = prod ? prod.productName : "";
          if (!b.offerText && offer.offerPrecentage) {
            b.offerText = `${offer.offerPrecentage}% OFF`;
          }
          if (!b.title) {
            b.title = prod ? prod.productName : "Special Offer";
          }
          if (!b.subtitle) {
            b.subtitle = `Exclusive discount on premium products!`;
          }
        } else if (offer.offerType === "category") {
          const cat = await Category.findOne({ _id: offer.refId, isDeleted: false });
          b.redirectType = "category";
          b.redirectValue = cat ? cat._id.toString() : "";
          if (!b.offerText && offer.offerPrecentage) {
            b.offerText = `${offer.offerPrecentage}% OFF`;
          }
          if (!b.title) {
            b.title = cat ? `${cat.categoryName} Special` : "Special Offer";
          }
          if (!b.subtitle) {
            b.subtitle = `Unbeatable deals on top categories!`;
          }
        }
      } else {
        b.redirectType = "";
        b.redirectValue = "";
      }
      banners.push(b);
    }

    // Split banners by type
    const heroBanners = banners.filter((b) => b.type === "hero");
    const promoBanners = banners.filter((b) => b.type === "promo");

    // Helper: get the best offer % for a product
    const getOfferPct = (pid, cid) =>
      activeOffers
        .filter((o) => 
          (o.offerType === "product" && o.refId.toString() === pid) ||
          (o.offerType === "category" && o.refId.toString() === cid)
        )
        .reduce((max, o) => Math.max(max, o.offerPrecentage), 0);

    // Batch query reviews to compute ratings in-memory
    const allProductIds = [
      ...rawProducts.map((p) => p._id),
      ...recentProducts.map((p) => p._id),
    ];

    const reviews = await mongoose.connection
      .collection("reviews")
      .find({ productId: { $in: allProductIds } })
      .toArray();

    const ratingsMap = {};
    reviews.forEach((r) => {
      const pid = r.productId.toString();
      if (!ratingsMap[pid]) ratingsMap[pid] = { sum: 0, count: 0 };
      ratingsMap[pid].sum += r.rating || 0;
      ratingsMap[pid].count += 1;
    });

    const getAvgRating = (pid) => {
      const entry = ratingsMap[pid];
      return entry && entry.count > 0 ? parseFloat((entry.sum / entry.count).toFixed(1)) : 4.5;
    };

    // ── Wishlist State ──
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

    // Build featured products (max 12, only those with variants)
    const featuredProducts = [];

    for (const product of rawProducts) {
      if (featuredProducts.length >= 12) break;

      const variant = await Variant.findOne({
        productId: product._id,
        isDeleted: false,
        isActive: true,
      }).lean();

      if (!variant) continue;

      const offerPct = getOfferPct(product._id.toString(), product.categoryId.toString());
      const originalPrice = Number(variant.price) || 0;
      const finalPrice = offerPct > 0
        ? Math.round(originalPrice * (1 - offerPct / 100))
        : originalPrice;

      const variantId = variant._id.toString();
      const wishlisted = wishlistedVariantIds.has(variantId) || wishlistedProductIds.has(product._id.toString());

      featuredProducts.push({
        _id: product._id,
        productName: product.productName,
        brandName: product.brandName,
        categoryId: product.categoryId,
        price: finalPrice,
        mrp: Number(variant.mrp || variant.price) || 0,
        offerPct,
        stock: variant.stock || 0,
        image: variant.images?.[0] || "",
        variantId: variant._id,
        avgRating: getAvgRating(product._id.toString()),
        wishlisted,
      });
    }

    // Build new arrivals (max 4, most recently added with variants)
    const newArrivals = [];

    for (const product of recentProducts) {
      if (newArrivals.length >= 4) break;

      const variant = await Variant.findOne({
        productId: product._id,
        isDeleted: false,
        isActive: true,
      }).lean();

      if (!variant) continue;

      const offerPct = getOfferPct(product._id.toString(), product.categoryId.toString());
      const originalPrice = Number(variant.price) || 0;
      const finalPrice = offerPct > 0
        ? Math.round(originalPrice * (1 - offerPct / 100))
        : originalPrice;

      const variantId = variant._id.toString();
      const wishlisted = wishlistedVariantIds.has(variantId) || wishlistedProductIds.has(product._id.toString());

      newArrivals.push({
        _id: product._id,
        productName: product.productName,
        brandName: product.brandName,
        categoryId: product.categoryId,
        price: finalPrice,
        mrp: Number(variant.mrp || variant.price) || 0,
        offerPct,
        stock: variant.stock || 0,
        image: variant.images?.[0] || "",
        variantId: variant._id,
        description: product.description || "",
        wishlisted,
      });
    }

    res.render("user/home", {
      user: sessionUser,
      categories,
      heroBanners,
      promoBanners,
      featuredProducts,
      newArrivals,
    });

  } catch (err) {
    next(err);
  }
}