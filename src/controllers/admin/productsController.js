import Product from "../../model/productModel.js";
import Variant from "../../model/variantModel.js";
import Category from "../../model/categoryModel.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AppError } from "../../errors/appError.js";
import { deleteFromCloudinary } from "../../services/cloudinaryService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PER_PAGE = 8;

function deleteProductImage(imagePath) {
  if (!imagePath) return;

  //Delete image if hosted from cloudnary
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    deleteFromCloudinary(imagePath);
    return;
  }

  // Delete local file from public folder
  const absolutePath = path.join(__dirname, "../../public", imagePath);
  if (fs.existsSync(absolutePath)) {
    fs.unlink(absolutePath, (error) => {
      if (error && error.code !== "ENOENT") {
        console.error("Error deleting local image file:", absolutePath, error.message);
      }
    });
  }
}

/**
 * Helper function to convert an uploaded file object into a public web image path.
 */
function getWebImagePath(file) {
  if (file.path && (file.path.startsWith("http://") || file.path.startsWith("https://"))) {
    return file.path;
  }
  const normalizedPath = file.path ? file.path.replace(/\\/g, "/") : "";
  const pathParts = normalizedPath.split("/public/");
  if (pathParts.length >= 2) {
    return "/" + pathParts[pathParts.length - 1];
  }
  return `/uploads/product/${file.filename}`;
}

/**
 * Helper function to convert variant options Map/Object into a plain JavaScript Object.
 */
function normalizeVariantOptions(variant) {
  let optionsObject = {};
  if (variant.options instanceof Map) {
    optionsObject = Object.fromEntries(variant.options);
  } else if (variant.options && typeof variant.options === "object") {
    optionsObject = variant.options;
  }

  return {
    ...variant,
    options: optionsObject,
  };
}

/**
 * Helper function to normalize product specifications map/object into a plain Object.
 */
function normalizeProductSpecifications(specifications) {
  if (!specifications) return {};
  if (specifications instanceof Map) return Object.fromEntries(specifications);
  if (typeof specifications === "object") return specifications;
  return {};
}

/**
 * Helper function to safely parse specifications JSON string into a key-value object.
 */
function parseSpecificationsInput(rawSpecifications) {
  const result = {};
  try {
    const parsedObject = typeof rawSpecifications === "string"
      ? JSON.parse(rawSpecifications || "{}")
      : rawSpecifications;

    if (parsedObject && typeof parsedObject === "object" && !Array.isArray(parsedObject)) {
      Object.entries(parsedObject).forEach(([key, value]) => {
        if (typeof value === "string" || typeof value === "number") {
          result[String(key).trim()] = String(value);
        }
      });
    }
  } catch (error) {
    // Return empty object on JSON parse failure
  }
  return result;
}

/**
 * Helper function to index uploaded variant images by variantIndex and imageIndex.
 */
function buildUploadedFilesMap(files) {
  const fileMap = {};
  (files || []).forEach((file) => {
    const match = file.fieldname.match(/^variantImages_(\d+)_(\d+)$/);
    if (match) {
      const key = `${match[1]}_${match[2]}`;
      fileMap[key] = file;
    }
  });
  return fileMap;
}

/**
 * Helper function to clean up / delete uploaded files when validation fails.
 */
function cleanupUploadedFiles(fileMap) {
  Object.values(fileMap).forEach((file) => {
    if (file.path && (file.path.startsWith("http://") || file.path.startsWith("https://"))) {
      deleteFromCloudinary(file.path);
    } else if (file.path && fs.existsSync(file.path)) {
      fs.unlink(file.path, () => {});
    }
  });
}

/**
 * Helper function to compile an array of 5 image paths for a variant.
 */
function buildVariantImagesList(variantIndex, variantMeta, fileMap) {
  const imagePaths = [];
  for (let imageIndex = 0; imageIndex < 5; imageIndex++) {
    const newUploadedFile = fileMap[`${variantIndex}_${imageIndex}`];
    const existingImageUrl = variantMeta.existingImages?.[imageIndex];

    if (newUploadedFile) {
      imagePaths.push(getWebImagePath(newUploadedFile));
    } else if (existingImageUrl) {
      imagePaths.push(existingImageUrl);
    }
  }
  return imagePaths;
}

/**
 * Helper function to check if any two variants have identical option combinations.
 */
function checkForDuplicateVariants(parsedVariants) {
  for (let i = 0; i < parsedVariants.length; i++) {
    for (let j = i + 1; j < parsedVariants.length; j++) {
      const optionsI = parsedVariants[i].options || {};
      const optionsJ = parsedVariants[j].options || {};
      const optionKeys = Object.keys(optionsI);

      if (optionKeys.length === 0) continue;

      const isDuplicate = optionKeys.every(
        (key) => String(optionsI[key] || "").trim().toUpperCase() === String(optionsJ[key] || "").trim().toUpperCase()
      );

      if (isDuplicate) {
        const optionCombo = optionKeys.map((key) => `${key}: ${optionsI[key]}`).join(", ");
        return `Duplicate variant found: Variants ${i + 1} and ${j + 1} have identical options (${optionCombo}).`;
      }
    }
  }
  return null;
}

// ==========================================
// CONTROLLER EXPORTS
// ==========================================

// 1. GET PRODUCTS LIST (Admin View / API)
export const getProducts = async (req, res) => {
  try {
    // Step 1: Read query parameters
    const requestedPage = parseInt(req.query.page, 10) || 1;
    const currentPage = Math.max(1, requestedPage);
    const searchQuery = (req.query.q || "").trim();
    const activeCategory = req.query.cat || "";
    const sortOrderParam = req.query.sort || "desc";
    const sortDirection = sortOrderParam === "asc" ? 1 : -1;
    const isAjaxRequest = req.query.ajax === "1";

    // Step 2: Construct database filter
    const filter = {
      isDeleted: false,
      ...(searchQuery && { productName: { $regex: searchQuery, $options: "i" } }),
      ...(activeCategory && { categoryId: activeCategory }),
    };

    // Step 3: Fetch products, categories, and total product count concurrently
    const itemsToSkip = (currentPage - 1) * PER_PAGE;

    const [products, categories, totalProducts] = await Promise.all([
      Product.find(filter)
        .populate("categoryId", "categoryName")
        .sort({ createdAt: sortDirection })
        .skip(itemsToSkip)
        .limit(PER_PAGE)
        .lean(),
      Category.find({ isDeleted: false, isActive: true }).lean(),
      Product.countDocuments(filter),
    ]);

    // Step 4: Fetch variants for the fetched products
    const productIds = products.map((product) => product._id);
    const allVariants = await Variant.find({
      productId: { $in: productIds },
      isDeleted: false,
    }).lean();

    // Step 5: Group variants by product ID
    const variantsByProduct = {};
    allVariants.forEach((variant) => {
      const productIdString = String(variant.productId);
      if (!variantsByProduct[productIdString]) {
        variantsByProduct[productIdString] = [];
      }
      variantsByProduct[productIdString].push(normalizeVariantOptions(variant));
    });

    // Step 6: Enrich products with minimum price, total stock, and variants array
    const enrichedProducts = products.map((product) => {
      const productVariants = variantsByProduct[String(product._id)] || [];
      const minPrice = productVariants.length
        ? Math.min(...productVariants.map((v) => v.price || 0))
        : 0;
      const totalStock = productVariants.reduce((total, v) => total + (v.stock || 0), 0);

      return {
        ...product,
        category: product.categoryId,
        variants: productVariants,
        minPrice: minPrice,
        totalStock: totalStock,
      };
    });

    // Step 7: Calculate pagination bounds
    const totalPages = Math.max(1, Math.ceil(totalProducts / PER_PAGE));
    const showingFrom = totalProducts === 0 ? 0 : itemsToSkip + 1;
    const showingTo = Math.min(itemsToSkip + PER_PAGE, totalProducts);

    // Step 8: Return response (JSON for AJAX or render EJS view)
    if (isAjaxRequest) {
      return res.json({
        success: true,
        products: enrichedProducts,
        total: totalProducts,
        currentPage: currentPage,
        totalPages: totalPages,
        showingFrom: showingFrom,
        showingTo: showingTo,
      });
    }

    return res.render("admin/products", {
      products: enrichedProducts,
      categories: categories,
      total: totalProducts,
      currentPage: currentPage,
      totalPages: totalPages,
      showingFrom: showingFrom,
      showingTo: showingTo,
      query: searchQuery,
      sort: sortOrderParam,
      activeCat: activeCategory,
    });
  } catch (error) {
    console.error("Error loading products list:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// 2. GET SINGLE PRODUCT BY ID
export const getProductById = async (req, res) => {
  try {
    const productId = req.params.id;

    // Step 1: Find product with populated category details
    const product = await Product.findOne({ _id: productId, isDeleted: false })
      .populate("categoryId", "categoryName specificationsConfig variantOptions")
      .lean();

    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    // Step 2: Fetch non-deleted variants for product
    const variants = await Variant.find({ productId: productId, isDeleted: false }).lean();

    // Step 3: Format specifications and variants, then return JSON
    return res.json({
      success: true,
      product: {
        ...product,
        category: product.categoryId,
        specifications: normalizeProductSpecifications(product.specifications),
        variants: variants.map(normalizeVariantOptions),
      },
    });
  } catch (error) {
    console.error("Error fetching product by ID:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// 3. CREATE NEW PRODUCT
export const createProduct = async (req, res) => {
  const fileMap = buildUploadedFilesMap(req.files);
  try {
    const { productName, brandName, category, description, isActive, specifications, variantsMeta } = req.body;

    // Step 1: Validate required basic fields
    if (!productName || !productName.trim()) {
      cleanupUploadedFiles(fileMap);
      return res.status(400).json({ success: false, message: "Product name is required." });
    }
    if (!category) {
      cleanupUploadedFiles(fileMap);
      return res.status(400).json({ success: false, message: "Category is required." });
    }

    // Step 2: Parse variants JSON data
    let parsedVariants = [];
    try {
      parsedVariants = JSON.parse(variantsMeta || "[]");
    } catch {
      parsedVariants = [];
    }

    if (parsedVariants.length === 0) {
      cleanupUploadedFiles(fileMap);
      return res.status(400).json({ success: false, message: "At least one variant is required." });
    }

    // Step 3: Check for duplicate variant option combinations
    const duplicateMessage = checkForDuplicateVariants(parsedVariants);
    if (duplicateMessage) {
      cleanupUploadedFiles(fileMap);
      return res.status(400).json({ success: false, message: duplicateMessage });
    }

    // Step 4: Verify that each variant has all 5 compulsory images
    for (let variantIndex = 0; variantIndex < parsedVariants.length; variantIndex++) {
      const variantImages = buildVariantImagesList(variantIndex, parsedVariants[variantIndex], fileMap);
      if (variantImages.length < 5) {
        cleanupUploadedFiles(fileMap);
        return res.status(400).json({
          success: false,
          message: `Variant ${variantIndex + 1}: All 5 images are compulsory (got ${variantImages.length}).`,
        });
      }
    }

    // Step 5: Create main product record in database
    const product = await Product.create({
      productName: productName.trim(),
      brandName: (brandName || "").trim(),
      categoryId: category,
      description: (description || "").trim(),
      isActive: isActive !== "false" && isActive !== false,
      specifications: parseSpecificationsInput(specifications),
    });

    // Step 6: Create variant records in database
    const variantDocuments = parsedVariants.map((variant, variantIndex) => ({
      productId: product._id,
      options: variant.options || {},
      price: Number(variant.price) || 0,
      stock: Number(variant.stock) || 0,
      images: buildVariantImagesList(variantIndex, variant, fileMap),
    }));

    await Variant.insertMany(variantDocuments);

    // Step 7: Return success response
    return res.status(201).json({ success: true, message: "Product created successfully." });
  } catch (error) {
    cleanupUploadedFiles(fileMap);
    console.error("Error creating product:", error);
    return res.status(500).json({ success: false, message: error.message || "Server error." });
  }
};

// 4. UPDATE EXISTING PRODUCT
export const updateProduct = async (req, res) => {
  const fileMap = buildUploadedFilesMap(req.files);
  try {
    const productId = req.params.id;
    const { productName, brandName, category, description, isActive, specifications, variantsMeta } = req.body;

    // Step 1: Validate required basic fields
    if (!productName || !productName.trim()) {
      cleanupUploadedFiles(fileMap);
      return res.status(400).json({ success: false, message: "Product name is required." });
    }
    if (!category) {
      cleanupUploadedFiles(fileMap);
      return res.status(400).json({ success: false, message: "Category is required." });
    }

    // Step 2: Parse variants JSON data
    let parsedVariants = [];
    try {
      parsedVariants = JSON.parse(variantsMeta || "[]");
    } catch {
      parsedVariants = [];
    }

    if (parsedVariants.length === 0) {
      cleanupUploadedFiles(fileMap);
      return res.status(400).json({ success: false, message: "At least one variant is required." });
    }

    // Step 3: Check for duplicate variant option combinations
    const duplicateMessage = checkForDuplicateVariants(parsedVariants);
    if (duplicateMessage) {
      cleanupUploadedFiles(fileMap);
      return res.status(400).json({ success: false, message: duplicateMessage });
    }

    // Step 4: Verify compulsory 5 images per variant
    for (let variantIndex = 0; variantIndex < parsedVariants.length; variantIndex++) {
      const variantImages = buildVariantImagesList(variantIndex, parsedVariants[variantIndex], fileMap);
      if (variantImages.length < 5) {
        cleanupUploadedFiles(fileMap);
        return res.status(400).json({
          success: false,
          message: `Variant ${variantIndex + 1}: All 5 images are compulsory (got ${variantImages.length}).`,
        });
      }
    }

    // Step 5: Find existing product in database
    const product = await Product.findOne({ _id: productId, isDeleted: false });
    if (!product) {
      cleanupUploadedFiles(fileMap);
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    // Step 6: Identify removed images and delete unused files from disk / Cloudinary
    const oldVariants = await Variant.find({ productId: productId, isDeleted: false }).lean();
    const oldImages = oldVariants.flatMap((v) => v.images || []);
    const keptImages = new Set(
      parsedVariants.flatMap((v) => (v.existingImages || []).filter(Boolean))
    );

    oldImages.forEach((imagePath) => {
      if (!keptImages.has(imagePath)) {
        deleteProductImage(imagePath);
      }
    });

    // Step 7: Update main product fields and save
    product.productName = productName.trim();
    product.brandName = (brandName || "").trim();
    product.categoryId = category;
    product.description = (description || "").trim();
    product.isActive = isActive !== "false" && isActive !== false;
    product.specifications = parseSpecificationsInput(specifications);
    await product.save();

    // Step 8: Soft-delete variants that were removed in the edit form
    const incomingVariantIds = parsedVariants.map((v) => v._id).filter(Boolean);

    await Variant.updateMany(
      {
        productId: productId,
        isDeleted: false,
        ...(incomingVariantIds.length > 0 && { _id: { $nin: incomingVariantIds } }),
      },
      { $set: { isDeleted: true } }
    );

    // Step 9: Update existing variants or insert new variants
    for (let variantIndex = 0; variantIndex < parsedVariants.length; variantIndex++) {
      const variant = parsedVariants[variantIndex];
      const variantImages = buildVariantImagesList(variantIndex, variant, fileMap);
      const variantData = {
        options: variant.options || {},
        price: Number(variant.price) || 0,
        stock: Number(variant.stock) || 0,
        images: variantImages,
        isDeleted: false,
      };

      if (variant._id) {
        await Variant.updateOne({ _id: variant._id, productId: productId }, { $set: variantData });
      } else {
        await Variant.create({ productId: product._id, ...variantData });
      }
    }

    // Step 10: Return success response
    return res.json({ success: true, message: "Product updated successfully." });
  } catch (error) {
    cleanupUploadedFiles(fileMap);
    console.error("Error updating product:", error);
    return res.status(500).json({ success: false, message: error.message || "Server error." });
  }
};

// 5. DELETE PRODUCT (Soft Delete)
export const deleteProduct = async (req, res) => {
  try {
    const productId = req.params.id;

    // Step 1: Find product in database
    const product = await Product.findOne({ _id: productId, isDeleted: false });
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    // Step 2: Delete image files associated with product variants
    const variants = await Variant.find({ productId: productId, isDeleted: false }).lean();
    variants.forEach((variant) => {
      (variant.images || []).forEach(deleteProductImage);
    });

    // Step 3: Soft delete product and variants by setting isDeleted = true
    await Promise.all([
      Product.updateOne({ _id: productId }, { $set: { isDeleted: true } }),
      Variant.updateMany({ productId: productId }, { $set: { isDeleted: true } }),
    ]);

    // Step 4: Return success response
    return res.json({ success: true, message: "Product deleted successfully." });
  } catch (error) {
    console.error("Error deleting product:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// 6. TOGGLE PRODUCT STATUS (Activate / Block)
export const toggleProductStatus = async (req, res, next) => {
  try {
    const productId = req.params.id;

    // Step 1: Find product in database
    const product = await Product.findOne({ _id: productId, isDeleted: false });
    if (!product) {
      throw new AppError(400, "Product not found");
    }

    // Step 2: Toggle isActive state
    product.isActive = !product.isActive;
    await product.save();

    // Step 3: Return success response
    return res.json({
      success: true,
      isActive: product.isActive,
      productName: product.productName,
      message: product.isActive ? "Product Activated" : "Product Blocked",
    });
  } catch (error) {
    next(error);
  }
};

// 7. TOGGLE VARIANT STATUS (Activate / Block)
export const toggleVariantStatus = async (req, res, next) => {
  try {
    const { id: productId, vid: variantId } = req.params;

    // Step 1: Find variant in database
    const variant = await Variant.findOne({ _id: variantId, productId: productId, isDeleted: false });
    if (!variant) {
      throw new AppError(404, "Variant not found");
    }

    // Step 2: Toggle isActive state
    variant.isActive = !variant.isActive;
    await variant.save();

    // Step 3: Return success response
    return res.json({
      success: true,
      isActive: variant.isActive,
      message: variant.isActive ? "Variant activated" : "Variant blocked",
    });
  } catch (error) {
    next(error);
  }
};
