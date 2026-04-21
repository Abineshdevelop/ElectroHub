import mongoose from "mongoose";
import Wishlist from "../../model/wishlistModel.js";
import WishlistItem from "../../model/wishlistItemModel.js";
import Product from "../../model/productModel.js";
import Cart from "../../model/cartModel.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const toId = (id) => new mongoose.Types.ObjectId(String(id));

const getOrCreateWishlist = async (userId) =>
  (await Wishlist.findOne({ userId })) ?? (await Wishlist.create({ userId }));

const getVariant = async (variantId, productId) => {
  const col = mongoose.connection.collection("variants");
  const query = { isDeleted: false };

  const raw = variantId
    ? await col.findOne({ _id: toId(variantId), ...query })
    : await col.findOne({ productId: toId(productId), ...query });

  if (!raw) return null;

  return {
    ...raw,
    _id: String(raw._id),
    productId: String(raw.productId),
    price: Number(raw.price) || 0,
    mrp: Number(raw.mrp) || 0,
    stock: Number(raw.stock) || 0,
    images: Array.isArray(raw.images) ? raw.images.map(String) : [],
    options: raw.options ? JSON.parse(JSON.stringify(raw.options)) : {},
  };
};

// ── Controllers ──────────────────────────────────────────────────────────────

export const getWishlist = async (req, res, next) => {
  try {
    const userId = req.session.user._id;
    const wishlist = await Wishlist.findOne({ userId });

    if (!wishlist) {
      return res.render("user/product/wishlist", {
        user: req.session.user,
        items: [],
        activePage: "wishlist",
      });
    }

    // Get cart variant IDs for "inCart" check
    const cart = await Cart.findOne({ userId: toId(userId) }).lean();
    const cartVariantIds = new Set(cart?.items?.map((i) => String(i.variantId)) ?? []);

    // Fetch wishlist items with product + variant
    const wishItems = await WishlistItem.find({ wishlistId: wishlist._id }).lean();

    const items = (
      await Promise.all(
        wishItems.map(async (item) => {
          const product = await Product.findOne({
            _id: item.productId,
            isDeleted: false,
            isActive: true,
          }).lean();

          if (!product) return null;

          const variant = await getVariant(item.variantId, item.productId);

          return {
            wishlistItemId: String(item._id),
            productId: product,
            variant,
            inCart: variant ? cartVariantIds.has(variant._id) : false,
          };
        })
      )
    ).filter(Boolean);

    return res.render("user/product/wishlist", {
      user: req.session.user,
      items,
      activePage: "wishlist",
    });
  } catch (err) {
    next(err);
  }
};

export const addToWishlist = async (req, res, next) => {
  try {
    const userId = req.session.user._id;
    const { productId, variantId } = req.body;

    const wishlist = await getOrCreateWishlist(userId);
    const exists = await WishlistItem.findOne({ wishlistId: wishlist._id, productId });

    if (exists) return res.json({ success: false, message: "Already in wishlist" });

    await WishlistItem.create({ wishlistId: wishlist._id, productId, variantId: variantId || null, quantity: 1 });
    return res.json({ success: true, message: "Added to wishlist" });
  } catch (err) {
    next(err);
  }
};

export const toggleWishlist = async (req, res, next) => {
  try {
    const userId = req.session.user._id;
    const { productId, variantId } = req.body;

    const wishlist = await getOrCreateWishlist(userId);
    const exists = await WishlistItem.findOne({ wishlistId: wishlist._id, productId });

    if (exists) {
      await WishlistItem.deleteMany({ wishlistId: wishlist._id, productId });
      return res.json({ success: true, wishlisted: false, message: "Removed from wishlist" });
    }

    await WishlistItem.create({ wishlistId: wishlist._id, productId, variantId: variantId || null, quantity: 1 });
    return res.json({ success: true, wishlisted: true, message: "Added to wishlist" });
  } catch (err) {
    next(err);
  }
};

export const removeFromWishlist = async (req, res, next) => {
  try {
    const userId = req.session.user._id;
    const { productId } = req.body;

    const wishlist = await Wishlist.findOne({ userId });
    if (!wishlist) return res.json({ success: false, message: "Wishlist not found" });

    const { deletedCount } = await WishlistItem.deleteMany({
      wishlistId: wishlist._id,
      productId: toId(productId),
    });

    return res.json({ success: true, message: "Removed", deleted: deletedCount });
  } catch (err) {
    next(err);
  }
};

export const removeFromWishlistByProduct = async (userId, productId) => {
  const wishlist = await Wishlist.findOne({ userId });
  if (!wishlist) return;
  await WishlistItem.deleteMany({ wishlistId: wishlist._id, productId: toId(productId) });
};