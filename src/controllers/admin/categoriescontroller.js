import Category from "../../model/categoryModel.js";
import { formatImagePath } from "../../utils/imageUtils.js";

export const getCategories = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 8;
    const searchQuery = req.query.q?.trim() || "";
    const sortOrder = req.query.sort === "asc" ? 1 : -1;
    const isAjax = req.query.ajax === "1";

    const filter = {
      isDeleted: false,
      ...(searchQuery && { categoryName: { $regex: searchQuery, $options: "i" } }),
    };

    const [categories, totalCategories] = await Promise.all([
      Category.find(filter).sort({ createdAt: sortOrder }).skip((page - 1) * limit).limit(limit).lean(),
      Category.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(totalCategories / limit) || 1;
    const showingFrom = totalCategories === 0 ? 0 : (page - 1) * limit + 1;
    const showingTo = Math.min(page * limit, totalCategories);

    if (isAjax) {
      return res.json({ categories, total: totalCategories, currentPage: page, totalPages, showingFrom, showingTo });
    }

    res.render("admin/categories", {
      categories,
      total: totalCategories,
      currentPage: page,
      totalPages,
      showingFrom,
      showingTo,
      query: searchQuery,
      sort: req.query.sort || "desc",
    });
  } catch (error) {
    console.error("getCategories:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

function validateCategoryBody({ categoryName, specificationsConfig, variantOptions }) {
  if (!categoryName?.trim()) {
    return "Category name is required.";
  }
  if (categoryName.trim().length > 50) {
    return "Category name must be 50 characters or fewer.";
  }
  if (!/^[a-zA-Z &\-\/]+$/.test(categoryName.trim())) {
    return "Category name can only contain letters, spaces, &, - or /.";
  }

  const specifications = Array.isArray(specificationsConfig) ? specificationsConfig : [];
  const variants = Array.isArray(variantOptions) ? variantOptions : [];

  if (variants.length === 0) {
    return "At least one variant option is required.";
  }

  const specificationNames = [];
  for (let specIndex = 0; specIndex < specifications.length; specIndex++) {
    const specName = (specifications[specIndex].name || "").trim();
    if (!specName) {
      return `Specification row ${specIndex + 1}: Field name is required.`;
    }
    if (specName.length > 50) {
      return `Specification "${specName}": cannot exceed 50 characters.`;
    }
    const lowerKey = specName.toLowerCase();
    if (specificationNames.includes(lowerKey)) {
      return `Duplicate specification: "${specName}".`;
    }
    specificationNames.push(lowerKey);
  }

  const variantNames = [];
  for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
    const variant = variants[variantIndex];
    const variantName = (variant.variantName || "").trim();

    if (!variantName) {
      return `Variant ${variantIndex + 1}: Variant name is required.`;
    }
    if (variantName.length > 30) {
      return `Variant "${variantName}": name cannot exceed 30 characters.`;
    }

    const variantKey = variantName.toLowerCase();
    if (variantNames.includes(variantKey)) {
      return `Duplicate variant: "${variantName}".`;
    }
    variantNames.push(variantKey);

    const usesSuffix = variant.usesSuffix === true || variant.usesSuffix === "true";

    if (!usesSuffix) {
      const plainValues = Array.isArray(variant.plainValues)
        ? variant.plainValues.map((value) => (value || "").trim()).filter(Boolean)
        : [];
      const seenValues = [];
      for (const val of plainValues) {
        if (val.length > 30) {
          return `Variant "${variantName}": Value "${val}" cannot exceed 30 characters.`;
        }
        const lowerVal = val.toLowerCase();
        if (seenValues.includes(lowerVal)) {
          return `Variant "${variantName}": Duplicate value "${val}".`;
        }
        seenValues.push(lowerVal);
      }
    } else {
      const suffixes = Array.isArray(variant.suffixes) ? variant.suffixes : [];
      if (suffixes.length === 0) {
        return `Variant "${variantName}": At least one suffix is required.`;
      }
      const usedUnits = [];
      for (let suffixIndex = 0; suffixIndex < suffixes.length; suffixIndex++) {
        const suffix = suffixes[suffixIndex];
        const unit = (suffix.unit || "").trim().toUpperCase();
        if (!unit) {
          return `Variant "${variantName}" suffix ${suffixIndex + 1}: Unit is required.`;
        }
        if (!/^[a-zA-Z]+$/.test(unit)) {
          return `Variant "${variantName}": Unit must contain letters only.`;
        }
        if (unit.length > 10) {
          return `Variant "${variantName}": Unit cannot exceed 10 characters.`;
        }
        const unitKey = unit.toLowerCase();
        if (usedUnits.includes(unitKey)) {
          return `Variant "${variantName}": Duplicate suffix unit "${unit}".`;
        }
        usedUnits.push(unitKey);
        const values = Array.isArray(suffix.values)
          ? suffix.values.map((value) => (value || "").trim()).filter(Boolean)
          : [];
        if (values.length === 0) {
          return `Variant "${variantName}" (${unit}): At least one value is required.`;
        }
        const seenSuffixValues = [];
        for (const val of values) {
          if (!/^[0-9]+$/.test(val)) {
            return `Variant "${variantName}" (${unit}): Values must be numbers only. Got "${val}".`;
          }
          if (val.length > 10) {
            return `Variant "${variantName}" (${unit}): Value "${val}" is too long.`;
          }
          if (seenSuffixValues.includes(val)) {
            return `Variant "${variantName}" (${unit}): Duplicate value "${val}".`;
          }
          seenSuffixValues.push(val);
        }
      }
    }
  }
  return null;
}

function cleanSpecifications(specificationsConfig) {
  return (Array.isArray(specificationsConfig) ? specificationsConfig : []).map((spec) => ({
    name:     spec.name.trim(),
    required: !!spec.required,
  }));
}

function cleanVariants(variantOptions) {
  return (Array.isArray(variantOptions) ? variantOptions : []).map((variant) => {
    const usesSuffix = variant.usesSuffix === true || variant.usesSuffix === "true";
    if (!usesSuffix) {
      return {
        variantName:  variant.variantName.trim(),
        usesSuffix:   false,
        plainValues:  (Array.isArray(variant.plainValues) ? variant.plainValues : [])
                        .map((value) => (value || "").trim()).filter(Boolean),
        suffixes:     [],
      };
    }
    return {
      variantName:  variant.variantName.trim(),
      usesSuffix:   true,
      plainValues:  [],
      suffixes: (Array.isArray(variant.suffixes) ? variant.suffixes : []).map((suffix) => ({
        unit:   (suffix.unit || "").trim().toUpperCase(),
        values: (Array.isArray(suffix.values) ? suffix.values : [])
                  .map((value) => (value || "").trim()).filter(Boolean),
      })),
    };
  });
}

export const createCategory = async (req, res) => {
  try {
    let { categoryName, description, isActive, specificationsConfig, variantOptions } = req.body;
    
    if (typeof specificationsConfig === 'string') {
      specificationsConfig = JSON.parse(specificationsConfig);//[ { name: 'regergergre', required: false } ] JSON string to JS object
    }
    if (typeof variantOptions === 'string') {
      variantOptions = JSON.parse(variantOptions);
    }

    const validationError = validateCategoryBody({ categoryName, specificationsConfig, variantOptions });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const existingCategory = await Category.findOne({
      categoryName: { $regex: `^${categoryName.trim()}$`, $options: "i" },
      isDeleted: false,
    });
    if (existingCategory) {
      return res.status(409).json({ success: false, message: "Category already exists." });
    }

    if (!req.file || !req.file.path) {
      return res.status(400).json({ success: false, message: "Category image is required." });
    }
    const imagePath = formatImagePath(req.file.path, "category");

    const category = await Category.create({
      categoryName:         categoryName.trim(),
      description:          (description || "").trim(),
      image:                imagePath,
      isActive:             isActive === true || isActive === "true",
      isDeleted:            false,
      specificationsConfig: cleanSpecifications(specificationsConfig),
      variantOptions:       cleanVariants(variantOptions),
    });

    res.status(201).json({ success: true, message: "Category created successfully.", category });
  } catch (error) {
    console.error("createCategory:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getCategoryById = async (req, res) => {
  try {
    const category = await Category.findOne({ _id: req.params.id, isDeleted: false }).lean();
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found." });
    }
    res.json({ success: true, category });
  } catch (error) {
    console.error("getCategoryById:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const updateCategory = async (req, res) => {
  try {
    let { categoryName, description, isActive, specificationsConfig, variantOptions } = req.body;

    if (typeof specificationsConfig === 'string') {
      specificationsConfig = JSON.parse(specificationsConfig);
    }
    if (typeof variantOptions === 'string') {
      variantOptions = JSON.parse(variantOptions);
    }

    const validationError = validateCategoryBody({ categoryName, specificationsConfig, variantOptions });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const duplicateCategory = await Category.findOne({
      _id:          { $ne: req.params.id },
      categoryName: { $regex: `^${categoryName.trim()}$`, $options: "i" },
      isDeleted:    false,
    });
    if (duplicateCategory) {
      return res.status(409).json({ success: false, message: "Another category with this name already exists." });
    }

    const category = await Category.findOne({ _id: req.params.id, isDeleted: false });
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found." });
    }

    const imageRemoved = req.body.imageRemoved === "true" || req.body.imageRemoved === true;
    if (imageRemoved && !req.file) {
      return res.status(400).json({ success: false, message: "Category image is required." });
    }
    if (!category.image && !req.file) {
      return res.status(400).json({ success: false, message: "Category image is required." });
    }

    category.categoryName         = categoryName.trim();
    category.description          = (description || "").trim();
    if (req.file) {
      category.image = formatImagePath(req.file.path, "category");
    } else if (imageRemoved) {
      category.image = "";
    }
    category.isActive             = isActive === true || isActive === "true";
    category.specificationsConfig = cleanSpecifications(specificationsConfig);
    category.variantOptions       = cleanVariants(variantOptions);

    await category.save();
    res.json({ success: true, message: "Category updated successfully.", category });
  } catch (error) {
    console.error("updateCategory:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const toggleCategoryStatus = async (req, res) => {
  try {
    const category = await Category.findOne({ _id: req.params.id, isDeleted: false });
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found." });
    }

    category.isActive = !category.isActive;
    await category.save();

    res.json({
      success:  true,
      message:  `Category ${category.isActive ? "activated" : "deactivated"}.`,
      isActive: category.isActive,
    });
  } catch (error) {
    console.error("toggleCategoryStatus:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const deleteCategory = async (req, res) => {
  try {
    const category = await Category.findOne({ _id: req.params.id, isDeleted: false });
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found." });
    }

    category.isDeleted = true;
    category.isActive  = false;
    await category.save();

    res.json({ success: true, message: "Category deleted successfully." });
  } catch (error) {
    console.error("deleteCategory:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};