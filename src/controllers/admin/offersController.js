import Offer from "../../model/offersModel.js";
import Product from "../../model/productModel.js";
import Category from "../../model/categoryModel.js";

const PAGE_SIZE_LIMIT = 10;

function validateOfferBody({
  offerName,
  offerType,
  refId,
  offerPercentage,
  startDate,
  endDate,
}) {
  const errors = [];

  if (!offerName || !offerName.trim()) {
    errors.push("Offer name is required.");
  } else if (offerName.trim().length < 3) {
    errors.push("Offer name must be at least 3 characters.");
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

  const numericPercentage = Number(offerPercentage);
  if (
    offerPercentage === undefined ||
    offerPercentage === null ||
    offerPercentage === ""
  ) {
    errors.push("Offer percentage is required.");
  } else if (isNaN(numericPercentage)) {
    errors.push("Offer percentage must be a number.");
  } else if (numericPercentage < 1) {
    errors.push("Offer percentage must be at least 1%.");
  } else if (numericPercentage > 100) {
    errors.push("Offer percentage cannot exceed 100%.");
  } else if (!Number.isInteger(numericPercentage)) {
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

async function populateOfferRef(offer) {
  const plainOffer = offer.toObject ? offer.toObject() : { ...offer };
  try {
    if (plainOffer.offerType === "product") {
      const product = await Product.findById(plainOffer.refId)
        .select("productName")
        .lean();
      plainOffer.refId = product
        ? { _id: product._id, productName: product.productName }
        : null;
    } else if (plainOffer.offerType === "category") {
      const category = await Category.findById(plainOffer.refId)
        .select("categoryName")
        .lean();
      plainOffer.refId = category
        ? { _id: category._id, categoryName: category.categoryName }
        : null;
    }
  } catch {
    plainOffer.refId = null;
  }
  return plainOffer;
}

async function applyOfferToProduct(productId, percentage) {
  const product = await Product.findById(productId);
  if (!product) return;
  product.variants.forEach((variant) => {
    variant.salePrice = Math.round(variant.price - (variant.price * percentage) / 100);
  });
  await product.save();
}

async function removeOfferFromProduct(productId) {
  const product = await Product.findById(productId);
  if (!product) return;
  product.variants.forEach((variant) => {
    variant.salePrice = null;
  });
  await product.save();
}

async function applyOfferToCategory(categoryId, percentage) {
  const products = await Product.find({
    categoryId,
    isActive: true,
    isDeleted: false,
  });
  for (const product of products) {
    await applyOfferToProduct(product._id, percentage);
  }
}

async function removeOfferFromCategory(categoryId) {
  const products = await Product.find({
    categoryId,
    isActive: true,
    isDeleted: false,
  });
  for (const product of products) {
    await removeOfferFromProduct(product._id);
  }
}

function getTabFilter(tab) {
  const now = new Date();
  const baseFilter = { isDeleted: false };

  if (tab === "active") return { ...baseFilter, isActive: true, endDate: { $gte: now } };
  if (tab === "inactive") return { ...baseFilter, isActive: false, endDate: { $gte: now } };
  if (tab === "expired") return { ...baseFilter, endDate: { $lt: now } };

  return baseFilter;
}

export const getOffersPage = async (req, res) => {
  try {
    const validTabs = ["all", "active", "inactive", "expired"];
    const activeTab = validTabs.includes(req.query.tab) ? req.query.tab : "all";
    const page = Math.max(1, Number(req.query.page) || 1);
    const isAjax = req.query.ajax === "1";

    const filter = getTabFilter(activeTab);

    const totalOffers = await Offer.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(totalOffers / PAGE_SIZE_LIMIT));
    const currentPage = Math.min(page, totalPages);

    const skip = (currentPage - 1) * PAGE_SIZE_LIMIT;
    const showingFrom = totalOffers ? skip + 1 : 0;
    const showingTo = Math.min(skip + PAGE_SIZE_LIMIT, totalOffers);

    const rawOffers = await Offer.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(PAGE_SIZE_LIMIT)
      .lean();

    const populatedOffers = await Promise.all(rawOffers.map(populateOfferRef));

    const responseData = {
      offers: populatedOffers,
      tab: activeTab,
      total: totalOffers,
      totalPages,
      currentPage,
      showingFrom,
      showingTo,
    };

    if (isAjax) {
      return res.json({ success: true, ...responseData });
    }

    res.render("admin/offers", responseData);
  } catch (error) {
    console.error("getOffersPage:", error);

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
      return res.status(400).json({ success: false, message: "Invalid offer ID" });
    }
    const rawOffer = await Offer.findOne({
      _id: req.params.id,
      isDeleted: false,
    }).lean();
    if (!rawOffer) {
      return res.status(404).json({ success: false, message: "Offer not found" });
    }
    const populatedOffer = await populateOfferRef(rawOffer);
    res.json({ success: true, offer: populatedOffer });
  } catch (error) {
    console.error("getOfferById:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const searchProducts = async (req, res) => {
  try {
    const searchQuery = (req.query.q || "").trim();
    if (!searchQuery) return res.json({ results: [] });
    if (searchQuery.length > 100) {
      return res.status(400).json({ results: [], message: "Query too long" });
    }

    const products = await Product.find({
      productName: { $regex: searchQuery, $options: "i" },
      isActive: true,
      isDeleted: false,
    })
      .select("productName")
      .limit(10)
      .lean();

    res.json({
      results: products.map((product) => ({ _id: product._id, name: product.productName })),
    });
  } catch (error) {
    console.error("searchProducts:", error);
    res.status(500).json({ results: [] });
  }
};

export const searchCategories = async (req, res) => {
  try {
    const searchQuery = (req.query.q || "").trim();
    if (!searchQuery) return res.json({ results: [] });
    if (searchQuery.length > 100) {
      return res.status(400).json({ results: [], message: "Query too long" });
    }

    const categories = await Category.find({
      categoryName: { $regex: searchQuery, $options: "i" },
      isDeleted: false,
    })
      .select("categoryName")
      .limit(10)
      .lean();

    res.json({
      results: categories.map((category) => ({ _id: category._id, name: category.categoryName })),
    });
  } catch (error) {
    console.error("searchCategories:", error);
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

    const validationErrors = validateOfferBody({
      offerName,
      offerType,
      refId,
      offerPercentage: offerPrecentage,
      startDate,
      endDate,
    });
    if (validationErrors.length) {
      return res.status(400).json({ success: false, message: validationErrors[0] });
    }

    if (offerType === "product") {
      const exists = await Product.findOne({
        _id: refId,
        isActive: true,
        isDeleted: false,
      });
      if (!exists) {
        return res.status(400).json({
          success: false,
          message: "Selected product not found or inactive",
        });
      }
    } else {
      const exists = await Category.findOne({ _id: refId, isDeleted: false });
      if (!exists) {
        return res.status(400).json({
          success: false,
          message: "Selected category not found",
        });
      }
    }

    const duplicateOffer = await Offer.findOne({
      refId,
      offerType,
      isDeleted: false,
      endDate: { $gte: new Date() },
    });
    if (duplicateOffer) {
      return res.status(409).json({
        success: false,
        message: `An active offer already exists for this ${offerType}. Please edit or delete it first.`,
      });
    }

    const percentage = Number(offerPrecentage);
    const offer = await Offer.create({
      offerName: offerName.trim(),
      offerType,
      refId,
      offerPrecentage: percentage,
      startDate: new Date(startDate),
      endDate: new Date(endDate + "T23:59:59"),
      isActive: isActive === true || isActive === "true",
    });

    if (offer.isActive && new Date(offer.endDate) >= new Date()) {
      if (offerType === "product") await applyOfferToProduct(refId, percentage);
      if (offerType === "category") await applyOfferToCategory(refId, percentage);
    }

    res.status(201).json({ success: true, message: "Offer created successfully", offer });
  } catch (error) {
    console.error("createOffer:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ success: false, message: "Invalid product or category ID" });
    }
    res.status(500).json({ success: false, message: "Failed to create offer" });
  }
};

export const editOffer = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ success: false, message: "Invalid offer ID" });
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

    const validationErrors = validateOfferBody({
      offerName,
      offerType,
      refId,
      offerPercentage: offerPrecentage,
      startDate,
      endDate,
    });
    if (validationErrors.length) {
      return res.status(400).json({ success: false, message: validationErrors[0] });
    }

    const offer = await Offer.findOne({ _id: req.params.id, isDeleted: false });
    if (!offer) {
      return res.status(404).json({ success: false, message: "Offer not found" });
    }

    if (offerType === "product") {
      const exists = await Product.findOne({
        _id: refId,
        isActive: true,
        isDeleted: false,
      });
      if (!exists) {
        return res.status(400).json({
          success: false,
          message: "Selected product not found or inactive",
        });
      }
    } else {
      const exists = await Category.findOne({ _id: refId, isDeleted: false });
      if (!exists) {
        return res.status(400).json({
          success: false,
          message: "Selected category not found",
        });
      }
    }

    const duplicateOffer = await Offer.findOne({
      _id: { $ne: req.params.id },
      refId,
      offerType,
      isDeleted: false,
      endDate: { $gte: new Date() },
    });
    if (duplicateOffer) {
      return res.status(409).json({
        success: false,
        message: `Another active offer already exists for this ${offerType}.`,
      });
    }

    if (offer.isActive) {
      if (offer.offerType === "product") {
        await removeOfferFromProduct(offer.refId);
      }
      if (offer.offerType === "category") {
        await removeOfferFromCategory(offer.refId);
      }
    }

    const percentage = Number(offerPrecentage);
    offer.offerName = offerName.trim();
    offer.offerType = offerType;
    offer.refId = refId;
    offer.offerPrecentage = percentage;
    offer.startDate = new Date(startDate);
    offer.endDate = new Date(endDate + "T23:59:59");
    offer.isActive = isActive === true || isActive === "true";
    await offer.save();

    if (offer.isActive && new Date(offer.endDate) >= new Date()) {
      if (offerType === "product") await applyOfferToProduct(refId, percentage);
      if (offerType === "category") await applyOfferToCategory(refId, percentage);
    }

    res.json({ success: true, message: "Offer updated successfully", offer });
  } catch (error) {
    console.error("editOffer:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ success: false, message: "Invalid ID provided" });
    }
    res.status(500).json({ success: false, message: "Failed to update offer" });
  }
};

export const toggleOffer = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ success: false, message: "Invalid offer ID" });
    }

    const offer = await Offer.findOne({ _id: req.params.id, isDeleted: false });
    if (!offer) {
      return res.status(404).json({ success: false, message: "Offer not found" });
    }

    if (new Date(offer.endDate) < new Date()) {
      return res.status(400).json({ success: false, message: "Cannot toggle an expired offer" });
    }

    offer.isActive = !offer.isActive;
    await offer.save();

    if (offer.isActive) {
      if (offer.offerType === "product") {
        await applyOfferToProduct(offer.refId, offer.offerPrecentage);
      }
      if (offer.offerType === "category") {
        await applyOfferToCategory(offer.refId, offer.offerPrecentage);
      }
    } else {
      if (offer.offerType === "product") {
        await removeOfferFromProduct(offer.refId);
      }
      if (offer.offerType === "category") {
        await removeOfferFromCategory(offer.refId);
      }
    }

    res.json({
      success: true,
      message: `Offer ${offer.isActive ? "enabled" : "disabled"} successfully`,
      isActive: offer.isActive,
      offerName: offer.offerName,
      endDate: offer.endDate,
    });
  } catch (error) {
    console.error("toggleOffer:", error);
    res.status(500).json({ success: false, message: "Failed to toggle offer" });
  }
};

export const deleteOffer = async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ success: false, message: "Invalid offer ID" });
    }

    const offer = await Offer.findOne({ _id: req.params.id, isDeleted: false });
    if (!offer) {
      return res.status(404).json({ success: false, message: "Offer not found" });
    }

    if (offer.isActive) {
      if (offer.offerType === "product") {
        await removeOfferFromProduct(offer.refId);
      }
      if (offer.offerType === "category") {
        await removeOfferFromCategory(offer.refId);
      }
    }

    offer.isDeleted = true;
    offer.isActive = false;
    await offer.save();

    res.json({ success: true, message: "Offer deleted successfully" });
  } catch (error) {
    console.error("deleteOffer:", error);
    res.status(500).json({ success: false, message: "Failed to delete offer" });
  }
};
