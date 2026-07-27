import Product from "../../model/productModel.js";
import Variant from "../../model/variantModel.js";
import Category from "../../model/categoryModel.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AppError } from "../../errors/appError.js";
import { deleteFromCloudinary } from "../../services/cloudinaryService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PER_PAGE   = 8;

function deleteImageFile(imagePath) {
  if (!imagePath) return;
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    deleteFromCloudinary(imagePath);
    return;
  }
  const absolutePath = path.join(__dirname, "../../public", imagePath);
  if (fs.existsSync(absolutePath)) {
    fs.unlink(absolutePath, (err) => {
      if (err && err.code !== "ENOENT") console.error("Delete error:", absolutePath, err.message);
    });
  }
}

function getWebPath(file) {
  if (file.path && (file.path.startsWith("http://") || file.path.startsWith("https://"))) {
    return file.path;
  }
  const normalizedPath = file.path ? file.path.replace(/\\/g, "/") : "";
  const parts = normalizedPath.split("/public/");
  if (parts.length >= 2) return "/" + parts[parts.length - 1];
  return `/uploads/product/${file.filename}`;
}

function normalizeVariant(variant) {
  return {
    ...variant,
    options:
      variant.options instanceof Map
        ? Object.fromEntries(variant.options)
        : variant.options && typeof variant.options === "object"
          ? variant.options
          : {},
  };
}

function normalizeSpecs(specifications) {
  if (!specifications) return {};
  if (specifications instanceof Map) return Object.fromEntries(specifications);
  if (typeof specifications === "object") return specifications;
  return {};
}

function parseSpecs(rawSpecifications) {
  const result = {};
  try {
    const obj = typeof rawSpecifications === "string" ? JSON.parse(rawSpecifications || "{}") : rawSpecifications;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      Object.entries(obj).forEach(([key, value]) => {
        if (typeof value === "string" || typeof value === "number") {
          result[String(key).trim()] = String(value);
        }
      });
    }
  } catch {
    /* ignore */
  }
  return result;
}

function buildFileMap(files) {
  const fileMap = {};
  (files || []).forEach((file) => {
    const match = file.fieldname.match(/^variantImages_(\d+)_(\d+)$/);
    if (match) fileMap[`${match[1]}_${match[2]}`] = file;
  });
  return fileMap;
}

function cleanupFileMap(fileMap) {
  Object.values(fileMap).forEach((file) => {
    if (file.path && (file.path.startsWith("http://") || file.path.startsWith("https://"))) {
      deleteFromCloudinary(file.path);
    } else if (file.path && fs.existsSync(file.path)) {
      fs.unlink(file.path, () => {});
    }
  });
}

function buildVariantImages(variantIndex, variantMeta, fileMap) {
  const images = [];
  for (let imageIndex = 0; imageIndex < 5; imageIndex++) {
    const newFile     = fileMap[`${variantIndex}_${imageIndex}`];
    const existingUrl = variantMeta.existingImages?.[imageIndex];
    if (newFile) {
      images.push(getWebPath(newFile));
    } else if (existingUrl) {
      images.push(existingUrl);
    }
  }
  return images;
}

function findDuplicateVariant(parsedVariants) {
  for (let i = 0; i < parsedVariants.length; i++) {
    for (let j = i + 1; j < parsedVariants.length; j++) {
      const optionsI = parsedVariants[i].options || {};
      const optionsJ = parsedVariants[j].options || {};
      const keys     = Object.keys(optionsI);
      if (keys.length === 0) continue;
      const isDuplicate = keys.every(
        (key) => String(optionsI[key] || "").trim().toUpperCase() === String(optionsJ[key] || "").trim().toUpperCase(),
      );
      if (isDuplicate) {
        const optionCombo = keys.map((key) => `${key}: ${optionsI[key]}`).join(", ");
        return `Duplicate variant found: Variants ${i + 1} and ${j + 1} have identical options (${optionCombo}).`;
      }
    }
  }
  return null;
}

export const getProducts = async (req, res) => {
  try {
    const page           = parseInt(req.query.page) || 1;
    const searchQuery    = req.query.q?.trim() || "";
    const activeCategory = req.query.cat || "";
    const sortOrder      = req.query.sort === "asc" ? 1 : -1;
    const isAjax         = req.query.ajax === "1";

    const filter = {
      isDeleted: false,
      ...(searchQuery && { productName: { $regex: searchQuery, $options: "i" } }),
      ...(activeCategory && { categoryId: activeCategory }),
    };

    const [products, categories, totalProducts] = await Promise.all([
      Product.find(filter)
        .populate("categoryId", "categoryName")
        .sort({ createdAt: sortOrder })
        .skip((page - 1) * PER_PAGE)
        .limit(PER_PAGE)
        .lean(),
      Category.find({ isDeleted: false, isActive: true }).lean(),
      Product.countDocuments(filter),
    ]);

    const productIds  = products.map((p) => p._id);
    const allVariants = await Variant.find({ productId: { $in: productIds }, isDeleted: false }).lean();

    const variantsByProduct = {};
    allVariants.forEach((variant) => {
      const productIdString = String(variant.productId);
      if (!variantsByProduct[productIdString]) variantsByProduct[productIdString] = [];
      variantsByProduct[productIdString].push(normalizeVariant(variant));
    });

    const totalPages  = Math.max(1, Math.ceil(totalProducts / PER_PAGE));
    const showingFrom = totalProducts === 0 ? 0 : (page - 1) * PER_PAGE + 1;
    const showingTo   = Math.min(page * PER_PAGE, totalProducts);

    const enrichedProducts = products.map((product) => {
      const variants   = variantsByProduct[String(product._id)] || [];
      const minPrice   = variants.length ? Math.min(...variants.map((v) => v.price || 0)) : 0;
      const totalStock = variants.reduce((acc, v) => acc + (v.stock || 0), 0);
      return { ...product, category: product.categoryId, variants, minPrice, totalStock };
    });

    if (isAjax) {
      return res.json({
        success: true,
        products: enrichedProducts,
        total: totalProducts,
        currentPage: page,
        totalPages,
        showingFrom,
        showingTo,
      });
    }

    res.render("admin/products", {
      products: enrichedProducts,
      categories,
      total: totalProducts,
      currentPage: page,
      totalPages,
      showingFrom,
      showingTo,
      query: searchQuery,
      sort: req.query.sort || "desc",
      activeCat: activeCategory,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

export const getProductById = async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, isDeleted: false })
      .populate("categoryId", "categoryName specificationsConfig variantOptions")
      .lean();
    if (!product) return res.status(404).json({ success: false, message: "Product not found." });

    const variants = await Variant.find({ productId: req.params.id, isDeleted: false }).lean();

    res.json({
      success: true,
      product: {
        ...product,
        category: product.categoryId,
        specifications: normalizeSpecs(product.specifications),
        variants: variants.map(normalizeVariant),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

export const createProduct = async (req, res) => {
  const fileMap = buildFileMap(req.files);
  try {
    const { productName, brandName, category, description, isActive, specifications, variantsMeta } = req.body;

    if (!productName?.trim()) {
      cleanupFileMap(fileMap);
      return res.status(400).json({ success: false, message: "Product name is required." });
    }
    if (!category) {
      cleanupFileMap(fileMap);
      return res.status(400).json({ success: false, message: "Category is required." });
    }

    let parsedVariants = [];
    try {
      parsedVariants = JSON.parse(variantsMeta || "[]");
    } catch {
      parsedVariants = [];
    }

    if (parsedVariants.length === 0) {
      cleanupFileMap(fileMap);
      return res.status(400).json({ success: false, message: "At least one variant is required." });
    }

    const duplicateMessage = findDuplicateVariant(parsedVariants);
    if (duplicateMessage) {
      cleanupFileMap(fileMap);
      return res.status(400).json({ success: false, message: duplicateMessage });
    }

    for (let variantIndex = 0; variantIndex < parsedVariants.length; variantIndex++) {
      const images = buildVariantImages(variantIndex, parsedVariants[variantIndex], fileMap);
      if (images.length < 5) {
        cleanupFileMap(fileMap);
        return res.status(400).json({
          success: false,
          message: `Variant ${variantIndex + 1}: All 5 images are compulsory (got ${images.length}).`,
        });
      }
    }

    const product = await Product.create({
      productName:    productName.trim(),
      brandName:      (brandName || "").trim(),
      categoryId:     category,
      description:    (description || "").trim(),
      isActive:       isActive !== "false" && isActive !== false,
      specifications: parseSpecs(specifications),
    });

    const variantDocs = parsedVariants.map((variant, variantIndex) => ({
      productId: product._id,
      options:   variant.options || {},
      price:     Number(variant.price) || 0,
      stock:     Number(variant.stock) || 0,
      images:    buildVariantImages(variantIndex, variant, fileMap),
    }));

    await Variant.insertMany(variantDocs);
    res.status(201).json({ success: true, message: "Product created successfully." });
  } catch (err) {
    cleanupFileMap(fileMap);
    console.error(err);
    res.status(500).json({ success: false, message: err.message || "Server error." });
  }
};

export const updateProduct = async (req, res) => {
  const fileMap = buildFileMap(req.files);
  try {
    const { productName, brandName, category, description, isActive, specifications, variantsMeta } = req.body;

    if (!productName?.trim()) {
      cleanupFileMap(fileMap);
      return res.status(400).json({ success: false, message: "Product name is required." });
    }
    if (!category) {
      cleanupFileMap(fileMap);
      return res.status(400).json({ success: false, message: "Category is required." });
    }

    let parsedVariants = [];
    try {
      parsedVariants = JSON.parse(variantsMeta || "[]");
    } catch {
      parsedVariants = [];
    }

    if (parsedVariants.length === 0) {
      cleanupFileMap(fileMap);
      return res.status(400).json({ success: false, message: "At least one variant is required." });
    }

    const duplicateMessage = findDuplicateVariant(parsedVariants);
    if (duplicateMessage) {
      cleanupFileMap(fileMap);
      return res.status(400).json({ success: false, message: duplicateMessage });
    }

    for (let variantIndex = 0; variantIndex < parsedVariants.length; variantIndex++) {
      const images = buildVariantImages(variantIndex, parsedVariants[variantIndex], fileMap);
      if (images.length < 5) {
        cleanupFileMap(fileMap);
        return res.status(400).json({
          success: false,
          message: `Variant ${variantIndex + 1}: All 5 images are compulsory (got ${images.length}).`,
        });
      }
    }

    const product = await Product.findOne({ _id: req.params.id, isDeleted: false });
    if (!product) {
      cleanupFileMap(fileMap);
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    const oldVariants = await Variant.find({ productId: req.params.id, isDeleted: false }).lean();
    const oldImages   = oldVariants.flatMap((variant) => variant.images || []);
    const keptImages  = new Set(parsedVariants.flatMap((variant) => (variant.existingImages || []).filter(Boolean)));

    oldImages.forEach((imagePath) => {
      if (!keptImages.has(imagePath)) deleteImageFile(imagePath);
    });

    product.productName    = productName.trim();
    product.brandName      = (brandName || "").trim();
    product.categoryId     = category;
    product.description    = (description || "").trim();
    product.isActive       = isActive !== "false" && isActive !== false;
    product.specifications = parseSpecs(specifications);
    await product.save();

    const incomingIds = parsedVariants.map((variant) => variant._id).filter(Boolean);

    await Variant.updateMany(
      {
        productId: req.params.id,
        isDeleted: false,
        ...(incomingIds.length > 0 && { _id: { $nin: incomingIds } }),
      },
      { $set: { isDeleted: true } },
    );

    for (let variantIndex = 0; variantIndex < parsedVariants.length; variantIndex++) {
      const variant = parsedVariants[variantIndex];
      const images  = buildVariantImages(variantIndex, variant, fileMap);
      const data    = {
        options:   variant.options || {},
        price:     Number(variant.price) || 0,
        stock:     Number(variant.stock) || 0,
        images,
        isDeleted: false,
      };

      if (variant._id) {
        await Variant.updateOne({ _id: variant._id, productId: req.params.id }, { $set: data });
      } else {
        await Variant.create({ productId: product._id, ...data });
      }
    }

    res.json({ success: true, message: "Product updated successfully." });
  } catch (err) {
    cleanupFileMap(fileMap);
    console.error(err);
    res.status(500).json({ success: false, message: err.message || "Server error." });
  }
};

export const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, isDeleted: false });
    if (!product) return res.status(404).json({ success: false, message: "Product not found." });

    const variants = await Variant.find({ productId: req.params.id, isDeleted: false }).lean();
    variants.forEach((variant) => (variant.images || []).forEach(deleteImageFile));

    await Promise.all([
      Product.updateOne({ _id: req.params.id }, { $set: { isDeleted: true } }),
      Variant.updateMany({ productId: req.params.id }, { $set: { isDeleted: true } }),
    ]);

    res.json({ success: true, message: "Product deleted successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

export const toggleProductStatus = async (req, res, next) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, isDeleted: false });
    if (!product) throw new AppError(400, "Product not found");

    product.isActive = !product.isActive;
    await product.save();

    res.json({
      success: true,
      isActive: product.isActive,
      productName: product.productName,
      message: product.isActive ? "Product Activated" : "Product Blocked",
    });
  } catch (err) {
    next(err);
  }
};

export const toggleVariantStatus = async (req, res, next) => {
  try {
    const variant = await Variant.findOne({ _id: req.params.vid, productId: req.params.id, isDeleted: false });
    if (!variant) throw new AppError(404, "Variant not found");

    variant.isActive = !variant.isActive;
    await variant.save();

    return res.json({
      success: true,
      isActive: variant.isActive,
      message: variant.isActive ? "Variant activated" : "Variant blocked",
    });
  } catch (err) {
    next(err);
  }
};
