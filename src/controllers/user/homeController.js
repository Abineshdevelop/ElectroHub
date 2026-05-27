import mongoose from "mongoose";
import Banner from "../../model/bannerModel.js";
import Category from "../../model/categoryModel.js";
import Product from "../../model/productModel.js";
import Variant from "../../model/variantModel.js";
import Offer from "../../model/offersModel.js";
import Wishlist from "../../model/wishlistModel.js";
import WishlistItem from "../../model/wishlistItemModel.js";
import User from "../../model/usermodel.js"

export async function loadHomePage(req, res, next) {
  try {
    const sessionUser = req.user || req.session?.user || null;
    const now = new Date();

    // const www=req.session.user._id
    // console.log(www)
    // const w=await User.findOne({_id:www})

//console.log("hi",w)

    // Fetch all data in parallel
    const [categories, bannersRaw, activeOffers, rawProducts, recentProducts] = await Promise.all([
      Category.find({ isDeleted: false, isActive: true }).lean(),
      Banner.find({ isDeleted: false, status: "active" }).populate("offerId").lean(),
      Offer.find({ isActive: true, isDeleted: false, startDate: { $lte: now }, endDate: { $gte: now } }).lean(),
      Product.find({ isDeleted: false, isActive: true }).lean(),
      Product.find({ isDeleted: false, isActive: true }).sort({ createdAt: -1 }).limit(12).lean(),
    ]);

    const banners = [];
    for (const banner of bannersRaw) {
      if (banner.offerId) {
        const offer = banner.offerId;
        if (offer.offerType === "product") {
          const product = await Product.findOne({ _id: offer.refId, isDeleted: false });
          banner.redirectType = "product";
          banner.redirectValue = product ? product.productName : "";
          if (!banner.offerText && offer.offerPrecentage) {
            banner.offerText = `${offer.offerPrecentage}% OFF`;
          }
          if (!banner.title) {
            banner.title = product ? product.productName : "Special Offer";
          }
          if (!banner.subtitle) {
            banner.subtitle = `Exclusive discount on premium products!`;
          }
        } else if (offer.offerType === "category") {
          const category = await Category.findOne({ _id: offer.refId, isDeleted: false });
          banner.redirectType = "category";
          banner.redirectValue = category ? category._id.toString() : "";
          if (!banner.offerText && offer.offerPrecentage) {
            banner.offerText = `${offer.offerPrecentage}% OFF`;
          }
          if (!banner.title) {
            banner.title = category ? `${category.categoryName} Special` : "Special Offer";
          }
          if (!banner.subtitle) {
            banner.subtitle = `Unbeatable deals on top categories!`;
          }
        }
      } else {
        banner.redirectType = "";
        banner.redirectValue = "";
      }
      banners.push(banner);
    }

    // Split banners by type
    const heroBanners = banners.filter((banner) => banner.type === "hero");
    const promoBanners = banners.filter((banner) => banner.type === "promo");

    // Helper: get the best offer % for a product
    const getOfferPercentage = (productId, categoryId) =>
      activeOffers
        .filter((offer) => 
          (offer.offerType === "product" && offer.refId.toString() === productId) ||
          (offer.offerType === "category" && offer.refId.toString() === categoryId)
        )
        .reduce((maxPercentage, offer) => Math.max(maxPercentage, offer.offerPrecentage), 0);

    // Batch query reviews to compute ratings in-memory
    const allProductIds = [
      ...rawProducts.map((product) => product._id),
      ...recentProducts.map((product) => product._id),
    ];

    const reviews = await mongoose.connection
      .collection("reviews")
      .find({ productId: { $in: allProductIds } })
      .toArray();

    const ratingsMap = {};
    reviews.forEach((review) => {
      const productId = review.productId.toString();
      if (!ratingsMap[productId]) {
        ratingsMap[productId] = { totalRatingSum: 0, reviewCount: 0 };
      }
      ratingsMap[productId].totalRatingSum += review.rating || 0;
      ratingsMap[productId].reviewCount += 1;
    });

    const getAvgRating = (productId) => {
      const entry = ratingsMap[productId];
      return entry && entry.reviewCount > 0 ? parseFloat((entry.totalRatingSum / entry.reviewCount).toFixed(1)) : 4.5;
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

      const offerPercentage = getOfferPercentage(product._id.toString(), product.categoryId.toString());
      const originalPrice = Number(variant.price) || 0;
      const finalPrice = offerPercentage > 0
        ? Math.round(originalPrice * (1 - offerPercentage / 100))
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
        offerPct: offerPercentage,
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

      const offerPercentage = getOfferPercentage(product._id.toString(), product.categoryId.toString());
      const originalPrice = Number(variant.price) || 0;
      const finalPrice = offerPercentage > 0
        ? Math.round(originalPrice * (1 - offerPercentage / 100))
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
        offerPct: offerPercentage,
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

  } catch (error) {
    next(error);
  }
}