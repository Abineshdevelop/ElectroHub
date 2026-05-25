import Product from "../../model/productModel.js";
import Variant from "../../model/variantModel.js";
import Category from "../../model/categoryModel.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";
import { AppError } from "../../errors/appError.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function deleteImageFile(imagePath) {
  if (!imagePath) return;
  const absPath = path.join(__dirname, "../../public", imagePath);
  fs.unlink(absPath, (err) => {
    if (err && err.code !== "ENOENT")
      console.error("Delete error:", absPath, err.message);
  });
}

function getWebPath(file) {
  const normalized = file.path.replace(/\\/g, "/");
  const parts = normalized.split("/public/");
  if (parts.length >= 2) return "/" + parts[parts.length - 1];
  return `/uploads/product/${file.filename}`;
}

function normalizeVariant(v) {
  return {
    ...v,
    options:
      v.options instanceof Map
        ? Object.fromEntries(v.options)
        : v.options && typeof v.options === "object"
          ? v.options
          : {},
  };
}

function normalizeSpecs(specs) {
  if (!specs) return {};
  if (specs instanceof Map) return Object.fromEntries(specs);
  if (typeof specs === "object") return specs;
  return {};
}

function parseSpecs(raw) {
  const result = {};
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      Object.entries(obj).forEach(([k, v]) => {
        if (typeof v === "string" || typeof v === "number") {
          result[String(k).trim()] = String(v);
        }
      });
    }
  } catch {
    /* ignore */
  }
  return result;
}

function buildFileMap(files) {
  const map = {};
  (files || []).forEach((f) => {
    const match = f.fieldname.match(/^variantImages_(\d+)_(\d+)$/);
    if (match) map[`${match[1]}_${match[2]}`] = f;
  });
  return map;
}

function cleanupFileMap(fileMap) {
  Object.values(fileMap).forEach((f) => {
    fs.unlink(f.path, () => {});
  });
}

function buildVariantImages(vi, variantMeta, fileMap) {
  const images = [];
  for (let si = 0; si < 5; si++) {
    const newFile = fileMap[`${vi}_${si}`];
    const existingUrl = variantMeta.existingImages?.[si];
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
      const optsI = parsedVariants[i].options || {};
      const optsJ = parsedVariants[j].options || {};
      const keys = Object.keys(optsI);
      if (keys.length === 0) continue;
      const isDup = keys.every(
        (k) =>
          String(optsI[k] || "")
            .trim()
            .toUpperCase() ===
          String(optsJ[k] || "")
            .trim()
            .toUpperCase(),
      );
      if (isDup) {
        const combo = keys.map((k) => `${k}: ${optsI[k]}`).join(", ");
        return `Duplicate variant found: Variants ${i + 1} and ${j + 1} have identical options (${combo}).`;
      }
    }
  }
  return null;
}

export const getProducts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 8;
    const q = req.query.q?.trim() || "";
    const cat = req.query.cat || "";
    const sort = req.query.sort === "asc" ? 1 : -1;
    const isAjax = req.query.ajax === "1";

    const filter = {
      isDeleted: false,
      ...(q && { productName: { $regex: q, $options: "i" } }),
      ...(cat && { categoryId: cat }),
    };

    const [products, categories, total] = await Promise.all([
      Product.find(filter)
        .populate("categoryId", "categoryName")
        .sort({ createdAt: sort })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Category.find({ isDeleted: false, isActive: true }).lean(),
      Product.countDocuments(filter),
    ]);

    const productIds = products.map((p) => p._id);
    const allVariants = await Variant.find({
      productId: { $in: productIds },
      isDeleted: false,
    }).lean();

    const variantsByProduct = {};
    allVariants.forEach((v) => {
      const pid = String(v.productId);
      if (!variantsByProduct[pid]) variantsByProduct[pid] = [];
      variantsByProduct[pid].push(normalizeVariant(v));
    });

    const totalPages = Math.ceil(total / limit) || 1;
    const showingFrom = total === 0 ? 0 : (page - 1) * limit + 1;
    const showingTo = Math.min(page * limit, total);

    const enriched = products.map((p) => {
      const variants = variantsByProduct[String(p._id)] || [];
      const minPrice = variants.length
        ? Math.min(...variants.map((v) => v.price || 0))
        : 0;
      const totalStock = variants.reduce((s, v) => s + (v.stock || 0), 0);
      return { ...p, category: p.categoryId, variants, minPrice, totalStock };
    });

    if (isAjax) {
      return res.json({
        success: true,
        products: enriched,
        total,
        currentPage: page,
        totalPages,
        showingFrom,
        showingTo,
      });
    }

    res.render("admin/products", {
      products: enriched,
      categories,
      total,
      currentPage: page,
      totalPages,
      showingFrom,
      showingTo,
      query: q,
      sort: req.query.sort || "desc",
      activeCat: cat,
    });
  } catch (err) {
    console.error("getProducts:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getProductById = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      isDeleted: false,
    })
      .populate(
        "categoryId",
        "categoryName specificationsConfig variantOptions",
      )
      .lean();
    if (!product)
      return res
        .status(404)
        .json({ success: false, message: "Product not found." });

    const variants = await Variant.find({
      productId: req.params.id,
      isDeleted: false,
    }).lean();

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
    console.error("getProductById:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const createProduct = async (req, res) => {
  const fileMap = buildFileMap(req.files);
  try {
    const {
      productName,
      brandName,
      category,
      description,
      isActive,
      specifications,
      variantsMeta,
    } = req.body;

    if (!productName?.trim()) {
      cleanupFileMap(fileMap);
      return res
        .status(400)
        .json({ success: false, message: "Product name is required." });
    }
    if (!category) {
      cleanupFileMap(fileMap);
      return res
        .status(400)
        .json({ success: false, message: "Category is required." });
    }

    let parsedVariants = [];
    try {
      parsedVariants = JSON.parse(variantsMeta || "[]");
    } catch {
      parsedVariants = [];
    }

    if (parsedVariants.length === 0) {
      cleanupFileMap(fileMap);
      return res
        .status(400)
        .json({ success: false, message: "At least one variant is required." });
    }

    //prevent dupicate varient
    const dupMsg = findDuplicateVariant(parsedVariants);
    if (dupMsg) {
      cleanupFileMap(fileMap);
      return res.status(400).json({ success: false, message: dupMsg });
    }

    // all 5 images per variant 
    for (let vi = 0; vi < parsedVariants.length; vi++) {
      const images = buildVariantImages(vi, parsedVariants[vi], fileMap);
      if (images.length < 5) {
        cleanupFileMap(fileMap);
        return res.status(400).json({
          success: false,
          message: `Variant ${vi + 1}: All 5 images are compulsory (got ${images.length}).`,
        });
      }
    }

    const product = await Product.create({
      productName: productName.trim(),
      brandName: (brandName || "").trim(),
      categoryId: category,
      description: (description || "").trim(),
      isActive: isActive !== "false" && isActive !== false,
      specifications: parseSpecs(specifications),
    });

    const variantDocs = parsedVariants.map((v, vi) => ({
      productId: product._id,
      options: v.options || {},
      price: Number(v.price) || 0,
      stock: Number(v.stock) || 0,
      images: buildVariantImages(vi, v, fileMap),
    }));

    await Variant.insertMany(variantDocs);
    res
      .status(201)
      .json({ success: true, message: "Product created successfully." });
  } catch (err) {
    cleanupFileMap(fileMap);
    console.error("createProduct:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Server error" });
  }
};

export const updateProduct = async (req, res) => {
  const fileMap = buildFileMap(req.files);
  try {
    const {
      productName,
      brandName,
      category,
      description,
      isActive,
      specifications,
      variantsMeta,
    } = req.body;

    if (!productName?.trim()) {
      cleanupFileMap(fileMap);
      return res
        .status(400)
        .json({ success: false, message: "Product name is required." });
    }
    if (!category) {
      cleanupFileMap(fileMap);
      return res
        .status(400)
        .json({ success: false, message: "Category is required." });
    }

    let parsedVariants = [];
    try {
      parsedVariants = JSON.parse(variantsMeta || "[]");
    } catch {
      parsedVariants = [];
    }

    if (parsedVariants.length === 0) {
      cleanupFileMap(fileMap);
      return res
        .status(400)
        .json({ success: false, message: "At least one variant is required." });
    }

    const dupMsg = findDuplicateVariant(parsedVariants);
    if (dupMsg) {
      cleanupFileMap(fileMap);
      return res.status(400).json({ success: false, message: dupMsg });
    }

    for (let vi = 0; vi < parsedVariants.length; vi++) {
      const images = buildVariantImages(vi, parsedVariants[vi], fileMap);
      if (images.length < 5) {
        cleanupFileMap(fileMap);
        return res.status(400).json({
          success: false,
          message: `Variant ${vi + 1}: All 5 images are compulsory (got ${images.length}).`,
        });
      }
    }

    const product = await Product.findOne({
      _id: req.params.id,
      isDeleted: false,
    });
    if (!product) {
      cleanupFileMap(fileMap);
      return res
        .status(404)
        .json({ success: false, message: "Product not found." });
    }

    const oldVariants = await Variant.find({
      productId: req.params.id,
      isDeleted: false,
    }).lean();
    const oldImages = oldVariants.flatMap((v) => v.images || []);
    const keptImages = new Set(
      parsedVariants.flatMap((v) => (v.existingImages || []).filter(Boolean)),
    );
    oldImages.forEach((imgPath) => {
      if (!keptImages.has(imgPath)) deleteImageFile(imgPath);
    });

    product.productName = productName.trim();
    product.brandName = (brandName || "").trim();
    product.categoryId = category;
    product.description = (description || "").trim();
    product.isActive = isActive !== "false" && isActive !== false;
    product.specifications = parseSpecs(specifications);
    await product.save();

    const incomingIds = parsedVariants.map((v) => v._id).filter(Boolean);

    // soft-delete variants that were REMOVED by admin
    // Only delete variants whose _id is NOT in the incoming list
    await Variant.updateMany(
      {
        productId: req.params.id,
        isDeleted: false,
        ...(incomingIds.length > 0 && { _id: { $nin: incomingIds } }),
      },
      { $set: { isDeleted: true } },  //delete varient not in the incoming list
    );

    //  update existing variants insert new ones
    for (let vi = 0; vi < parsedVariants.length; vi++) {
      const v = parsedVariants[vi];
      const images = buildVariantImages(vi, v, fileMap);
      const data = {
        options: v.options || {},
        price: Number(v.price) || 0,
        stock: Number(v.stock) || 0,
        images,
        isDeleted: false,
      };

      if (v._id) {
        // existing variant  update in place, preserve _id so cart still works
        await Variant.updateOne(
          { _id: v._id, productId: req.params.id },
          { $set: data },
        );
      } else {
        // brand new variant added by admin
        await Variant.create({ productId: product._id, ...data });
      }
    }

    res.json({ success: true, message: "Product updated successfully." });
  } catch (err) {
    cleanupFileMap(fileMap);
    console.error("updateProduct:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Server error" });
  }
};

export const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      isDeleted: false,
    });
    if (!product)
      return res
        .status(404)
        .json({ success: false, message: "Product not found." });

    const variants = await Variant.find({
      productId: req.params.id,
      isDeleted: false,
    }).lean();
    variants.forEach((v) => (v.images || []).forEach(deleteImageFile));

    await Promise.all([
      Product.updateOne({ _id: req.params.id }, { $set: { isDeleted: true } }),
      Variant.updateMany(
        { productId: req.params.id },
        { $set: { isDeleted: true } },
      ),
    ]);

    res.json({ success: true, message: "Product deleted successfully." });
  } catch (err) {
    console.error("deleteProduct:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

//admin block or unlist controller

export const toggleProductsStauts = async (req, res, next) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      isDeleted: false,
    });
    if (!product) {
      throw new AppError(400, "Product not found");
    }
    product.isActive = !product.isActive;
    await product.save();

    res.json({
      success: true,
      isActive: product.isActive,
      productName: product.productName,
      message: product.isActive ? "Product Unblocked " : "product Blocked",
    });
  } catch (err) {
    next(err);
  }
};

export const toggleVariantStatus = async (req, res, next) => {
  try {
    const variant = await Variant.findOne({
      _id: req.params.vid,
      productId: req.params.id,
      isDeleted: false,
    });
    if (!variant) {
      throw new AppError(404, "Variant not found");
    }
    variant.isActive = !variant.isActive;
    await variant.save();

    return res.json({
      success:true,
      isActive:variant.isActive,
      message: variant.isActive?"Variant unblocked":"Variant blocked"
    })

  } catch (err) {
    next(err);
  }
};
