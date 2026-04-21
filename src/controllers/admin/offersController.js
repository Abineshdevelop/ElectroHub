import Offer from "../../model/offersModel.js";
import Product from "../../model/productModel.js";
import Category from "../../model/categoryModel.js";

const LIMIT = 10;

function validateOfferBody({
  offerName,
  offerType,
  refId,
  offerPrecentage,
  startDate,
  endDate,
}) {
  const errors = [];

  if (!offerName || !offerName.trim()) {
    errors.push("Offer name is required.");
  } else if (offerName.trim().length < 3) {
    errors.push("Offer name must be at least 3 characters.");
    e;
  } else if (offerName.trim().length > 30) {
    errors.push("Offer name must not exceed 30 characters.");
  }

  if (!offerType) {
    errors.push("Offer type is required.");
  } else if (!["product", "category"].includes(offerType)) {
    errors.push("Offer type must be 'product' or 'category'.");
  }

  if (!refId || !String(refId).trim()) {
    errors.push("Please select a valid product or category.");
  }

  const pct = Number(offerPrecentage);
  if (
    offerPrecentage === undefined ||
    offerPrecentage === null ||
    offerPrecentage === ""
  ) {
    errors.push("Offer percentage is required.");
  } else if (isNaN(pct)) {//offer presentage
    errors.push("Offer percentage must be a number.");
  } else if (pct < 1) {
    errors.push("Offer percentage must be at least 1%.");
  } else if (pct > 100) {
    errors.push("Offer percentage cannot exceed 100%.");
  } else if (!Number.isInteger(pct)) {
    errors.push("Offer percentage must be a whole number.");
  }

  if (!startDate) {
    errors.push("Start date is required.");
  } else if (isNaN(new Date(startDate).getTime())) {
    errors.push("Start date is invalid.");
  }

  if (!endDate) {
    errors.push("Expiry date is required.");
  } else if (isNaN(new Date(endDate).getTime())) {
    errors.push("Expiry date is invalid.");
  } else if (startDate && new Date(endDate) <= new Date(startDate)) {
    errors.push("Expiry date must be after the start date.");
  }

  return errors;
}

// Mongoose can't auto-populate refId because the schema has no `ref`.
// We manually fetch the correct model based on offerType.
async function populateOfferRef(offer) {
  const plain = offer.toObject ? offer.toObject() : { ...offer };
  try {
    if (plain.offerType === "product") {
      const product = await Product.findById(plain.refId)
        .select("productName")
        .lean();
      plain.refId = product
        ? { _id: product._id, productName: product.productName }
        : null;
    } else if (plain.offerType === "category") {
      const category = await Category.findById(plain.refId)
        .select("categoryName")
        .lean();
      plain.refId = category
        ? { _id: category._id, categoryName: category.categoryName }
        : null;
    }
  } catch {
    plain.refId = null;
  }
  return plain;
}

async function applyOfferToProduct(productId, percentage) {
  const product = await Product.findById(productId);
  if (!product) return;
  product.variants.forEach((v) => {
    v.salePrice = Math.round(v.price - (v.price * percentage) / 100);
  });
  await product.save();
}

async function removeOfferFromProduct(productId) {
  const product = await Product.findById(productId);
  if (!product) return;
  product.variants.forEach((v) => {
    v.salePrice = null;
  });
  await product.save();
}

async function applyOfferToCategory(categoryId, percentage) {
  const products = await Product.find({
    categoryId,
    isActive: true,
    isDeleted: false,
  });
  for (const p of products) await applyOfferToProduct(p._id, percentage);
}

async function removeOfferFromCategory(categoryId) {
  const products = await Product.find({
    categoryId,
    isActive: true,
    isDeleted: false,
  });
  for (const p of products) await removeOfferFromProduct(p._id);
}

function getTabFilter(tab) {
  const now = new Date();
  const base = { isDeleted: false };

  if (tab === "active")
    return { ...base, isActive: true, endDate: { $gte: now } };
  if (tab === "inactive")
    return { ...base, isActive: false, endDate: { $gte: now } };
  if (tab === "expired") return { ...base, endDate: { $lt: now } };

  return base;
}

export const getOffersPage = async (req, res) => {
  try {
    const validTabs = ["all", "active", "inactive", "expired"];

    let tab;
    if (validTabs.includes(req.query.tab)) {
      tab = req.query.tab;
    } else {
      tab = "all";
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const isAjax = req.query.ajax === "1";

    const filter = getTabFilter(tab);

    const total = await Offer.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / LIMIT));
    const currentPage = Math.min(page, totalPages);

    const skip = (currentPage - 1) * LIMIT;
    const showingFrom = total ? skip + 1 : 0;
    const showingTo = Math.min(skip + LIMIT, total);

    const rawOffers = await Offer.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(LIMIT)
      .lean();

    const offers = await Promise.all(rawOffers.map(populateOfferRef));

    const responseData = {
      offers,
      tab,
      total,
      totalPages,
      currentPage,
      showingFrom,
      showingTo,
    };

    if (isAjax) {
      return res.json({ success: true, ...responseData });
    }

    res.render("admin/offers", responseData);
  } catch (err) {
    console.error("getOffersPage:", err);

    if (req.query.ajax === "1") {
      return res.status(500).json({
        success: false,
        message: "Server error",
      });
    }

    res.status(500).render("error", {
      message: "Failed to load offers",
    });
  }
};

export const getOfferById = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid offer ID" });
    }
    const raw = await Offer.findOne({
      _id: req.params.id,
      isDeleted: false,
    }).lean();
    if (!raw)
      return res
        .status(404)
        .json({ success: false, message: "Offer not found" });
    const offer = await populateOfferRef(raw);
    res.json({ success: true, offer });
  } catch (err) {
    console.error("getOfferById:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const searchProducts = async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ results: [] });
    if (q.length > 100)
      return res.status(400).json({ results: [], message: "Query too long" });

    const products = await Product.find({
      productName: { $regex: q, $options: "i" },
      isActive: true,
      isDeleted: false,
    })
      .select("productName")
      .limit(10)
      .lean();

    res.json({
      results: products.map((p) => ({ _id: p._id, name: p.productName })),
    });
  } catch (err) {
    console.error("searchProducts:", err);
    res.status(500).json({ results: [] });
  }
};

export const searchCategories = async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ results: [] });
    if (q.length > 100)
      return res.status(400).json({ results: [], message: "Query too long" });

    const categories = await Category.find({
      categoryName: { $regex: q, $options: "i" },
      isDeleted: false,
    })
      .select("categoryName")
      .limit(10)
      .lean();

    res.json({
      results: categories.map((c) => ({ _id: c._id, name: c.categoryName })),
    });
  } catch (err) {
    console.error("searchCategories:", err);
    res.status(500).json({ results: [] });
  }
};

export const createOffer = async (req, res) => {
  try {
    const {
      offerName,
      offerType,
      refId,
      offerPrecentage,
      startDate,
      endDate,
      isActive,
    } = req.body;

    const errors = validateOfferBody({
      offerName,
      offerType,
      refId,
      offerPrecentage,
      startDate,
      endDate,
    });
    if (errors.length)
      return res.status(400).json({ success: false, message: errors[0] });

    if (offerType === "product") {
      const exists = await Product.findOne({
        _id: refId,
        isActive: true,
        isDeleted: false,
      });
      if (!exists)
        return res.status(400).json({
          success: false,
          message: "Selected product not found or inactive",
        });
    } else {
      const exists = await Category.findOne({ _id: refId, isDeleted: false });
      if (!exists)
        return res
          .status(400)
          .json({ success: false, message: "Selected category not found" });
    }

    const duplicate = await Offer.findOne({
      refId,
      offerType,
      isDeleted: false,
      endDate: { $gte: new Date() },
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: `An active offer already exists for this ${offerType}. Please edit or delete it first.`,
      });
    }

    const pct = Number(offerPrecentage);
    const offer = await Offer.create({
      offerName: offerName.trim(),
      offerType,
      refId,
      offerPrecentage: pct,
      startDate: new Date(startDate),
      endDate: new Date(endDate + "T23:59:59"),
      isActive: isActive === true || isActive === "true",
    });

    if (offer.isActive && new Date(offer.endDate) >= new Date()) {
      if (offerType === "product") await applyOfferToProduct(refId, pct);
      if (offerType === "category") await applyOfferToCategory(refId, pct);
    }

    res
      .status(201)
      .json({ success: true, message: "Offer created successfully", offer });
  } catch (err) {
    console.error("createOffer:", err);
    if (err.name === "CastError")
      return res
        .status(400)
        .json({ success: false, message: "Invalid product or category ID" });
    res.status(500).json({ success: false, message: "Failed to create offer" });
  }
};

export const editOffer = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid offer ID" });
    }

    const {
      offerName,
      offerType,
      refId,
      offerPrecentage,
      startDate,
      endDate,
      isActive,
    } = req.body;

    const errors = validateOfferBody({
      offerName,
      offerType,
      refId,
      offerPrecentage,
      startDate,
      endDate,
    });
    if (errors.length)
      return res.status(400).json({ success: false, message: errors[0] });

    const offer = await Offer.findOne({ _id: req.params.id, isDeleted: false });
    if (!offer)
      return res
        .status(404)
        .json({ success: false, message: "Offer not found" });

    if (offerType === "product") {
      const exists = await Product.findOne({
        _id: refId,
        isActive: true,
        isDeleted: false,
      });
      if (!exists)
        return res.status(400).json({
          success: false,
          message: "Selected product not found or inactive",
        });
    } else {
      const exists = await Category.findOne({ _id: refId, isDeleted: false });
      if (!exists)
        return res
          .status(400)
          .json({ success: false, message: "Selected category not found" });
    }

    const duplicate = await Offer.findOne({
      _id: { $ne: req.params.id },
      refId,
      offerType,
      isDeleted: false,
      endDate: { $gte: new Date() },
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: `Another active offer already exists for this ${offerType}.`,
      });
    }

    if (offer.isActive) {
      if (offer.offerType === "product")
        await removeOfferFromProduct(offer.refId);
      if (offer.offerType === "category")
        await removeOfferFromCategory(offer.refId);
    }

    const pct = Number(offerPrecentage);
    offer.offerName = offerName.trim();
    offer.offerType = offerType;
    offer.refId = refId;
    offer.offerPrecentage = pct;
    offer.startDate = new Date(startDate);
    offer.endDate = new Date(endDate + "T23:59:59");
    offer.isActive = isActive === true || isActive === "true";
    await offer.save();

    if (offer.isActive && new Date(offer.endDate) >= new Date()) {
      if (offerType === "product") await applyOfferToProduct(refId, pct);
      if (offerType === "category") await applyOfferToCategory(refId, pct);
    }

    res.json({ success: true, message: "Offer updated successfully", offer });
  } catch (err) {
    console.error("editOffer:", err);
    if (err.name === "CastError")
      return res
        .status(400)
        .json({ success: false, message: "Invalid ID provided" });
    res.status(500).json({ success: false, message: "Failed to update offer" });
  }
};

export const toggleOffer = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid offer ID" });
    }

    const offer = await Offer.findOne({ _id: req.params.id, isDeleted: false });
    if (!offer)
      return res
        .status(404)
        .json({ success: false, message: "Offer not found" });

    if (new Date(offer.endDate) < new Date()) {
      return res
        .status(400)
        .json({ success: false, message: "Cannot toggle an expired offer" });
    }

    offer.isActive = !offer.isActive;
    await offer.save();

    if (offer.isActive) {
      if (offer.offerType === "product")
        await applyOfferToProduct(offer.refId, offer.offerPrecentage);
      if (offer.offerType === "category")
        await applyOfferToCategory(offer.refId, offer.offerPrecentage);
    } else {
      if (offer.offerType === "product")
        await removeOfferFromProduct(offer.refId);
      if (offer.offerType === "category")
        await removeOfferFromCategory(offer.refId);
    }

    res.json({
      success: true,
      message: `Offer ${offer.isActive ? "enabled" : "disabled"} successfully`,
      isActive: offer.isActive,
      offerName: offer.offerName,
      endDate: offer.endDate,
    });
  } catch (err) {
    console.error("toggleOffer:", err);
    res.status(500).json({ success: false, message: "Failed to toggle offer" });
  }
};

export const deleteOffer = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid offer ID" });
    }

    const offer = await Offer.findOne({ _id: req.params.id, isDeleted: false });
    if (!offer)
      return res
        .status(404)
        .json({ success: false, message: "Offer not found" });

    if (offer.isActive) {
      if (offer.offerType === "product")
        await removeOfferFromProduct(offer.refId);
      if (offer.offerType === "category")
        await removeOfferFromCategory(offer.refId);
    }

    offer.isDeleted = true;
    offer.isActive = false;
    await offer.save();

    res.json({ success: true, message: "Offer deleted successfully" });
  } catch (err) {
    console.error("deleteOffer:", err);
    res.status(500).json({ success: false, message: "Failed to delete offer" });
  }
};
