import Cart from "../../model/cartModel.js";
import Product from "../../model/productModel.js";
import Variant from "../../model/variantModel.js";
import Offer from "../../model/offersModel.js";

const MAX_QTY = 10;
const CART_LIMIT = 20;

async function getActiveOffers() {
  const now = new Date();
  return await Offer.find({
    isActive: true,
    isDeleted: false,
    startDate: { $lte: now },
    endDate: { $gte: now },
  }).lean();
}

function findBestOffer(product, activeOffers) {
  let bestOffer = null;

  for (const offer of activeOffers) {
    const isProductOffer =
      offer.offerType === "product" &&
      String(offer.refId) === String(product._id); //true
    const isCategoryOffer =
      offer.offerType === "category" &&
      String(offer.refId) === String(product.categoryId); //true

    if (isProductOffer || isCategoryOffer) {
      if (!bestOffer || offer.offerPrecentage > bestOffer.offerPrecentage) {
        bestOffer = offer;
      }
    }
  }

  return bestOffer;
}

//caculate sale price after offer
function getSalePrice(variant, product, activeOffers) {
  const offer = findBestOffer(product, activeOffers);
  const offerPct = offer ? offer.offerPrecentage : 0;
  const originalPrice = Number(variant.price) || 0;
  const offerPrice =
    offerPct > 0
      ? Math.round(originalPrice * (1 - offerPct / 100))
      : originalPrice;

  return { offerPrice, originalPrice, offerPct };
}

export async function getCart(req, res, next) {
  try {
    const userId = req.session.user._id;

    const cart = await Cart.findOne({ userId });
    const activeOffers = await getActiveOffers();

    const enrichedItems = [];
    const validVariantIds = [];

    for (const cartItem of cart.items) {
      //looping cart item
      const product = await Product.findById(cartItem.productId)
        .select("productName isActive isDeleted categoryId")
        .lean();

      const variant = await Variant.findById(cartItem.variantId).lean();

      if (!product || !variant || variant.isDeleted) {
        //if the product or varient is nul or undevined varient is marked as is deleted true
        continue;
      }

      const variantLabel = variant.options
        ? Object.entries(variant.options)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" / ") //convert object in to array for varient ["color red" , "size":"m"]. "color: Red / size: M"
        : "";

      const { offerPrice, originalPrice, offerPct } = getSalePrice(
        variant,
        product,
        activeOffers,
      );

      const isAvailable = product.isActive && !product.isDeleted;

      enrichedItems.push({
        productId: product,
        variantId: variant._id,
        quantity: cartItem.quantity,
        variantLabel,
        price: offerPrice,
        originalPrice,
        offerPct,
        image: variant.images?.[0] || "/images/placeholder.png",
        stock: variant.stock,
        isAvailable,
        totalPrice: offerPrice * cartItem.quantity,
      });

      validVariantIds.push(String(variant._id));
    }

    // remove product or varient that is deleted
    const hadInvalidItems = enrichedItems.length !== cart.items.length;
    if (hadInvalidItems) {
      cart.items = cart.items.filter((i) =>
        validVariantIds.includes(String(i.variantId)),
      );
      await cart.save();
    }

    const subtotal = enrichedItems.reduce(
      (sum, item) => sum + item.totalPrice,
      0,
    );

    return res.render("user/cart/cart", {
      user: req.session.user,
      cart: { ...cart, items: enrichedItems }, //cart.Object()
      subtotal,
    });
  } catch (err) {
    next(err);
  }
}

export async function addToCart(req, res, next) {
  try {
    const userId = req.session.user._id;
    const { productId, variantId, quantity = 1 } = req.body;
    const qty = Number(quantity);

    if (!productId || !variantId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "productId and variantId are required",
        });
    }

    const product = await Product.findById(productId)
      .select("isActive isDeleted")
      .lean();
    const variant = await Variant.findById(variantId)
      .select("price stock isDeleted productId")
      .lean();

    if (!product || product.isDeleted || !product.isActive) {
      return res
        .status(404)
        .json({ success: false, message: "Product not available" });
    }

    if (!variant || variant.isDeleted) {
      return res
        .status(404)
        .json({ success: false, message: "Variant not available" });
    }

    if (variant.productId.toString() !== productId.toString()) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Variant does not belong to this product",
        });
    }

    let cart = await Cart.findOne({ userId });
    if (!cart) {
      cart = new Cart({ userId, items: [] });
    }

    const existingIndex = cart.items.findIndex(
      (i) =>
        i.productId.toString() === productId.toString() &&
        i.variantId.toString() === variantId.toString(),
    );

    if (existingIndex > -1) {
      const newQty = cart.items[existingIndex].quantity + qty;

      if (newQty > MAX_QTY) {
        return res.json({
          success: false,
          message: `Maximum ${MAX_QTY} units per item`,
        });
      }
      if (newQty > variant.stock) {
        return res.json({
          success: false,
          message: `Only ${variant.stock} units in stock`,
        });
      }

      cart.items[existingIndex].quantity = newQty;
    } else {
      if (cart.items.length >= CART_LIMIT) {
        return res.json({
          success: false,
          message: `Cart limit of ${CART_LIMIT} items reached`,
        });
      }
      if (qty > variant.stock) {
        return res.json({
          success: false,
          message: `Only ${variant.stock} units in stock`,
        });
      }

      cart.items.push({ productId, variantId, quantity: qty });
    }

    await cart.save();

    return res.json({
      success: true,
      message: "Added to cart",
      cartCount: cart.items.length,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateCart(req, res, next) {
  try {
    const userId = req.session.user._id;
    const { productId, variantId, quantity } = req.body;
    const qty = Number(quantity);

    if (!qty || qty < 1 || qty > MAX_QTY) {
      return res.status(400).json({
        success: false,
        message: `Quantity must be between 1 and ${MAX_QTY}`,
      });
    }

    const variant = await Variant.findById(variantId)
      .select("stock isDeleted")
      .lean();
    if (!variant || variant.isDeleted) {
      return res
        .status(404)
        .json({ success: false, message: "Variant not available" });
    }

    const cart = await Cart.findOne({ userId });

    if (!cart) {
      return res
        .status(404)
        .json({ success: false, message: "Cart not found" });
    }

    const item = cart.items.find(
      (i) =>
        i.productId.toString() === productId.toString() &&
        i.variantId.toString() === variantId.toString(),
    );

    if (!item) {
      return res
        .status(404)
        .json({ success: false, message: "Item not in cart" });
    }

    if (qty > item.quantity && qty > variant.stock) {
      return res.json({
        success: false,
        message: `Only ${variant.stock} units in stock`,
      });
    }

    item.quantity = qty;
    await cart.save();

    return res.json({ success: true, message: "Cart updated" });
  } catch (err) {
    next(err);
  }
}

export async function removeFromCart(req, res, next) {
  try {
    const userId = req.session.user._id;
    const { productId, variantId } = req.body;

    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return res
        .status(404)
        .json({ success: false, message: "Cart not found" });
    }
    const beforeCount = cart.items.length;
    cart.items = cart.items.filter(
      (i) =>
        i.productId.toString() !== productId.toString() ||
        i.variantId.toString() !== variantId.toString(),
    );
    // one product have multiple varient so for that varient and product filter and both equal then delete
    if (cart.items.length === beforeCount) {
      return res
        .status(404)
        .json({ success: false, message: "Item not found in cart" });
    }
    await cart.save();
    return res.json({ success: true, message: "Item removed" });
  } catch (err) {
    next(err);
  }
}

export async function clearCart(req, res, next) {
  try {
    const userId = req.session.user._id;
    await Cart.findOneAndUpdate({ userId }, { $set: { items: [] } });
    return res.json({ success: true, message: "Cart cleared" });
  } catch (err) {
    next(err);
  }
}
