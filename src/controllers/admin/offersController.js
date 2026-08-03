import Offer from "../../model/offersModel.js";
import Product from "../../model/productModel.js";
import Category from "../../model/categoryModel.js";

const PER_PAGE = 10;

function validateOfferInput(data) {
  const { offerName, offerType, refId, offerPercentage, startDate, endDate } = data;

  const cleanName = offerName ? offerName.trim() : "";
  if (!cleanName) {
    return "Offer name is required.";
  }
  if (cleanName.length < 3) {
    return "Offer name must be at least 3 characters.";
  }
  if (cleanName.length > 30) {
    return "Offer name must not exceed 30 characters.";
  }

  if (!offerType) {
    return "Offer type is required.";
  }
  if (offerType !== "product" && offerType !== "category") {
    return "Offer type must be 'product' or 'category'.";
  }

  if (!refId || !String(refId).trim()) {
    return "Please select a valid product or category.";
  }
  if (offerPercentage === undefined || offerPercentage === null || offerPercentage === "") {
    return "Offer percentage is required.";
  }

  const numericPercentage = Number(offerPercentage);
  if (isNaN(numericPercentage)) {
    return "Offer percentage must be a number.";
  }
  if (numericPercentage < 1) {
    return "Offer percentage must be at least 1%.";
  }
  if (numericPercentage > 100) {
    return "Offer percentage cannot exceed 100%.";
  }
  if (!Number.isInteger(numericPercentage)) {
    return "Offer percentage must be a whole number.";
  }
  if (!startDate) {
    return "Start date is required.";
  }
  const parsedStartDate = new Date(startDate);
  if (isNaN(parsedStartDate.getTime())) {
    return "Start date is invalid.";
  }
  if (!endDate) {
    return "Expiry date is required.";
  }
  const parsedEndDate = new Date(endDate);
  if (isNaN(parsedEndDate.getTime())) {
    return "Expiry date is invalid.";
  }
  if (parsedEndDate <= parsedStartDate) {
    return "Expiry date must be after the start date.";
  }
  return null;
}


 //function to attach Product or Category details to an offer object.
async function populateOfferReference(offer) {
  // Convert Mongoose document to a simple Javascript object if needed
  const offerObject = offer.toObject ? offer.toObject() : { ...offer };

  try {
    if (offerObject.offerType === "product") {
      const product = await Product.findById(offerObject.refId).select("productName").lean();
      if (product) {
        offerObject.refId = {
          _id: product._id,
          productName: product.productName,
        };
      } else {
        offerObject.refId = null;
      }
    } else if (offerObject.offerType === "category") {
      // Look up category name by ID
      const category = await Category.findById(offerObject.refId).select("categoryName").lean();
      if (category) {
        offerObject.refId = {
          _id: category._id,
          categoryName: category.categoryName,
        };
      } else {
        offerObject.refId = null;
      }
    }
  } catch (error) {
    offerObject.refId = null;
  }

  return offerObject;
}

//Applies offer percentage discount to all variants of a product.
async function applyOfferToProduct(productId, percentage) {
  const product = await Product.findById(productId);
  if (!product) return;

  // Update salePrice for each variant
  for (const variant of product.variants) {
    const discountAmount = (variant.price * percentage) / 100;
    variant.salePrice = Math.round(variant.price - discountAmount);
  }

  await product.save();
}


//Removes discount sale prices from all variants of a product.
async function removeOfferFromProduct(productId) {
  const product = await Product.findById(productId);
  if (!product) return;

  // Reset salePrice to null for each variant
  for (const variant of product.variants) {
    variant.salePrice = null;
  }

  await product.save();
}

async function applyOfferToCategory(categoryId, percentage) {
  const products = await Product.find({
    categoryId: categoryId,
    isActive: true,
    isDeleted: false,
  });

  for (const product of products) {
    await applyOfferToProduct(product._id, percentage);
  }
}

async function removeOfferFromCategory(categoryId) {
  const products = await Product.find({
    categoryId: categoryId,
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

    const requestedPage = parseInt(req.query.page, 10) || 1;
    const page = Math.max(1, requestedPage);
    const isAjaxRequest = req.query.ajax === "1";

    const filter = getTabFilter(activeTab);

    const totalOffers = await Offer.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(totalOffers / PER_PAGE));
    const currentPage = Math.min(page, totalPages);
    const skipItems = (currentPage - 1) * PER_PAGE;

    const showingFrom = totalOffers > 0 ? skipItems + 1 : 0;
    const showingTo = Math.min(skipItems + PER_PAGE, totalOffers);

    const rawOffers = await Offer.find(filter)
      .sort({ createdAt: -1 })
      .skip(skipItems)
      .limit(PER_PAGE)
      .lean();

    //replace referance id into actual offer or category 
    //in offers collection
    const populatedOffers = [];
    for (const offer of rawOffers) {
      const populated = await populateOfferReference(offer);
      populatedOffers.push(populated);
    }


    //final response object
    const responseData = {
      offers: populatedOffers,
      tab: activeTab,
      total: totalOffers,
      totalPages,
      currentPage,
      showingFrom,
      showingTo,
    };

    // Step 7: Send JSON for AJAX call or render EJS page
    if (isAjaxRequest) {
      return res.json({
        success: true,
        ...responseData,
      });
    }

    return res.render("admin/offers", responseData);
  } catch (error) {
    console.error("Error loading offers page:", error);
    if (req.query.ajax === "1") {
      return res.status(500).json({ success: false, message: "Server error." });
    }
    return res.status(500).render("error", { message: "Failed to load offers." });
  }
};


export const getOfferById = async (req, res) => {
  try {
    const offerId = req.params.id;

    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(offerId);
    if (!isValidObjectId) {
      return res.status(400).json({ success: false, message: "Invalid offer ID." });
    }

    const rawOffer = await Offer.findOne({ _id: offerId, isDeleted: false }).lean();
    if (!rawOffer) {
      return res.status(404).json({ success: false, message: "Offer not found." });
    }

    const populatedOffer = await populateOfferReference(rawOffer);
    return res.json({ success: true, offer: populatedOffer });
  } catch (error) {
    console.error("Error fetching offer by ID:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

export const searchProducts = async (req, res) => {
  try {
    const searchQuery = (req.query.q || "").trim();

    if (!searchQuery) {
      return res.json({ results: [] });
    }
    if (searchQuery.length > 100) {
      return res.status(400).json({ results: [], message: "Query too long." });
    }

    const products = await Product.find({
      productName: { $regex: searchQuery, $options: "i" },
      isActive: true,
      isDeleted: false,
    })
      .select("productName")
      .limit(10)
      .lean();

    const formattedResults = products.map((product) => ({
      _id: product._id,
      name: product.productName,
    }));

    return res.json({ results: formattedResults });
  } catch (error) {
    console.error("Error searching products:", error);
    return res.status(500).json({ results: [] });
  }
};

export const searchCategories = async (req, res) => {
  try {
    const searchQuery = (req.query.q || "").trim();

    if (!searchQuery) {
      return res.json({ results: [] });
    }
    if (searchQuery.length > 100) {
      return res.status(400).json({ results: [], message: "Query too long." });
    }

    const categories = await Category.find({
      categoryName: { $regex: searchQuery, $options: "i" },
      isDeleted: false,
    })
      .select("categoryName")
      .limit(10)
      .lean();

    const formattedResults = categories.map((category) => ({
      _id: category._id,
      name: category.categoryName,
    }));

    return res.json({ results: formattedResults });
  } catch (error) {
    console.error("Error searching categories:", error);
    return res.status(500).json({ results: [] });
  }
};

export const createOffer = async (req, res) => {
  try {
    const { offerName, offerType, refId, offerPrecentage, startDate, endDate, isActive } = req.body;

    const validationError = validateOfferInput({
      offerName,
      offerType,
      refId,
      offerPercentage: offerPrecentage,
      startDate,
      endDate,
    });

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (offerType === "product") {
      const productExists = await Product.findOne({ _id: refId, isActive: true, isDeleted: false });
      if (!productExists) {
        return res.status(400).json({ success: false, message: "Selected product not found or inactive." });
      }
    } else if (offerType === "category") {
      const categoryExists = await Category.findOne({ _id: refId, isDeleted: false });
      if (!categoryExists) {
        return res.status(400).json({ success: false, message: "Selected category not found." });
      }
    }

    const currentDate = new Date();
    const duplicateOffer = await Offer.findOne({
      refId: refId,
      offerType: offerType,
      isDeleted: false,
      endDate: { $gte: currentDate },
    });

    if (duplicateOffer) {
      return res.status(409).json({
        success: false,
        message: `An active offer already exists for this ${offerType}. Please edit or delete it first.`,
      });
    }

    const percentage = Number(offerPrecentage);
    const parsedStartDate = new Date(startDate);
    const parsedEndDate = new Date(endDate + "T23:59:59");
    const isOfferActive = isActive === true || isActive === "true";

    const newOffer = await Offer.create({
      offerName: offerName.trim(),
      offerType: offerType,
      refId: refId,
      offerPrecentage: percentage,
      startDate: parsedStartDate,
      endDate: parsedEndDate,
      isActive: isOfferActive,
    });

    if (newOffer.isActive && new Date(newOffer.endDate) >= new Date()) {
      if (offerType === "product") {
        await applyOfferToProduct(refId, percentage);
      } else if (offerType === "category") {
        await applyOfferToCategory(refId, percentage);
      }
    }

    return res.status(201).json({
      success: true,
      message: "Offer created successfully.",
      offer: newOffer,
    });
  } catch (error) {
    console.error("Error creating offer:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ success: false, message: "Invalid product or category ID." });
    }
    return res.status(500).json({ success: false, message: "Failed to create offer." });
  }
};

export const editOffer = async (req, res) => {
  try {
    const offerId = req.params.id;

    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(offerId);
    if (!isValidObjectId) {
      return res.status(400).json({ success: false, message: "Invalid offer ID." });
    }

    const { offerName, offerType, refId, offerPrecentage, startDate, endDate, isActive } = req.body;

    const validationError = validateOfferInput({
      offerName,
      offerType,
      refId,
      offerPercentage: offerPrecentage,
      startDate,
      endDate,
    });

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const offer = await Offer.findOne({ _id: offerId, isDeleted: false });
    if (!offer) {
      return res.status(404).json({ success: false, message: "Offer not found." });
    }

    if (offerType === "product") {
      const productExists = await Product.findOne({ _id: refId, isActive: true, isDeleted: false });
      if (!productExists) {
        return res.status(400).json({ success: false, message: "Selected product not found or inactive." });
      }
    } else if (offerType === "category") {
      const categoryExists = await Category.findOne({ _id: refId, isDeleted: false });
      if (!categoryExists) {
        return res.status(400).json({ success: false, message: "Selected category not found." });
      }
    }

    const currentDate = new Date();
    const duplicateOffer = await Offer.findOne({
      _id: { $ne: offerId },
      refId: refId,
      offerType: offerType,
      isDeleted: false,
      endDate: { $gte: currentDate },
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
      } else if (offer.offerType === "category") {
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
      if (offerType === "product") {
        await applyOfferToProduct(refId, percentage);
      } else if (offerType === "category") {
        await applyOfferToCategory(refId, percentage);
      }
    }

    return res.json({
      success: true,
      message: "Offer updated successfully.",
      offer: offer,
    });
  } catch (error) {
    console.error("Error editing offer:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ success: false, message: "Invalid ID provided." });
    }
    return res.status(500).json({ success: false, message: "Failed to update offer." });
  }
};

export const toggleOffer = async (req, res) => {
  try {
    const offerId = req.params.id;

    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(offerId);
    if (!isValidObjectId) {
      return res.status(400).json({ success: false, message: "Invalid offer ID." });
    }

    const offer = await Offer.findOne({ _id: offerId, isDeleted: false });
    if (!offer) {
      return res.status(404).json({ success: false, message: "Offer not found." });
    }

    const currentDate = new Date();
    if (new Date(offer.endDate) < currentDate) {
      return res.status(400).json({ success: false, message: "Cannot toggle an expired offer." });
    }

    offer.isActive = !offer.isActive;
    await offer.save();

    if (offer.isActive) {
      if (offer.offerType === "product") {
        await applyOfferToProduct(offer.refId, offer.offerPrecentage);
      } else if (offer.offerType === "category") {
        await applyOfferToCategory(offer.refId, offer.offerPrecentage);
      }
    } else {
      if (offer.offerType === "product") {
        await removeOfferFromProduct(offer.refId);
      } else if (offer.offerType === "category") {
        await removeOfferFromCategory(offer.refId);
      }
    }

    //Return success response
    const statusText = offer.isActive ? "enabled" : "disabled";
    return res.json({
      success: true,
      message: `Offer ${statusText} successfully.`,
      isActive: offer.isActive,
      offerName: offer.offerName,
      endDate: offer.endDate,
    });
  } catch (error) {
    console.error("Error toggling offer status:", error);
    return res.status(500).json({ success: false, message: "Failed to toggle offer." });
  }
};

export const deleteOffer = async (req, res) => {
  try {
    const offerId = req.params.id;

    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(offerId);
    if (!isValidObjectId) {
      return res.status(400).json({ success: false, message: "Invalid offer ID." });
    }

    const offer = await Offer.findOne({ _id: offerId, isDeleted: false });
    if (!offer) {
      return res.status(404).json({ success: false, message: "Offer not found." });
    }

    if (offer.isActive) {
      if (offer.offerType === "product") {
        await removeOfferFromProduct(offer.refId);
      } else if (offer.offerType === "category") {
        await removeOfferFromCategory(offer.refId);
      }
    }

    offer.isDeleted = true;
    offer.isActive = false;
    await offer.save();

    return res.json({ success: true, message: "Offer deleted successfully." });
  } catch (error) {
    console.error("Error deleting offer:", error);
    return res.status(500).json({ success: false, message: "Failed to delete offer." });
  }
};
