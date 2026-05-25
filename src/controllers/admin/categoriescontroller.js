import Category from "../../model/categoryModel.js";

export const getCategories = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 8;
    const q      = req.query.q?.trim()       || "";
    const sort   = req.query.sort === "asc"  ? 1 : -1;
    const isAjax = req.query.ajax === "1";

    const filter = {
      isDeleted: false,
      ...(q && { categoryName: { $regex: q, $options: "i" } }),
    };

    const [categories, total] = await Promise.all([
      Category.find(filter).sort({ createdAt: sort }).skip((page - 1) * limit).limit(limit).lean(),
      Category.countDocuments(filter),
    ]);

    const totalPages  = Math.ceil(total / limit) || 1;
    const showingFrom = total === 0 ? 0 : (page - 1) * limit + 1;
    const showingTo   = Math.min(page * limit, total);

    if (isAjax) {
      return res.json({ categories, total, currentPage: page, totalPages, showingFrom, showingTo });
    }

    res.render("admin/categories", {
      categories, total, currentPage: page,
      totalPages, showingFrom, showingTo,
      query: q, sort: req.query.sort || "desc",
    });
  } catch (err) {
    console.error("getCategories:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

function validateCategoryBody({ categoryName, specificationsConfig, variantOptions }) {
  if (!categoryName?.trim())
    return "Category name is required.";
  if (categoryName.trim().length > 50)
    return "Category name must be 50 characters or fewer.";
  if (!/^[a-zA-Z &\-\/]+$/.test(categoryName.trim()))
    return "Category name can only contain letters, spaces, &, - or /.";

  const specs    = Array.isArray(specificationsConfig) ? specificationsConfig : [];
  const variants = Array.isArray(variantOptions)       ? variantOptions       : [];

  if (variants.length === 0)
    return "At least one variant option is required.";

  const specNames = [];
  for (let i = 0; i < specs.length; i++) {
    const sName = (specs[i].name || "").trim();
    if (!sName)            return `Specification row ${i + 1}: Field name is required.`;
    if (sName.length > 50) return `Specification "${sName}": cannot exceed 50 characters.`;
    const key = sName.toLowerCase();
    if (specNames.includes(key)) return `Duplicate specification: "${sName}".`;
    specNames.push(key);
  }

  const variantNames = [];
  for (let vi = 0; vi < variants.length; vi++) {
    const v     = variants[vi];
    const vName = (v.variantName || "").trim();

    if (!vName)
      return `Variant ${vi + 1}: Variant name is required.`;
    if (vName.length > 30)
      return `Variant "${vName}": name cannot exceed 30 characters.`;

    const vKey = vName.toLowerCase();
    if (variantNames.includes(vKey)) return `Duplicate variant: "${vName}".`;
    variantNames.push(vKey);

    const usesSuffix = v.usesSuffix === true || v.usesSuffix === "true";

    if (!usesSuffix) {
      const plainValues = Array.isArray(v.plainValues)
        ? v.plainValues.map(x => (x || "").trim()).filter(Boolean)
        : [];
      const seen = [];
      for (const val of plainValues) {
        if (val.length > 30)
          return `Variant "${vName}": Value "${val}" cannot exceed 30 characters.`;
        const lc = val.toLowerCase();
        if (seen.includes(lc))
          return `Variant "${vName}": Duplicate value "${val}".`;
        seen.push(lc);
      }
    } else {
      const suffixes = Array.isArray(v.suffixes) ? v.suffixes : [];
      if (suffixes.length === 0)
        return `Variant "${vName}": At least one suffix is required.`;
      const usedUnits = [];
      for (let si = 0; si < suffixes.length; si++) {
        const s    = suffixes[si];
        const unit = (s.unit || "").trim().toUpperCase();
        if (!unit)
          return `Variant "${vName}" suffix ${si + 1}: Unit is required.`;
        if (!/^[a-zA-Z]+$/.test(unit))
          return `Variant "${vName}": Unit must contain letters only.`;
        if (unit.length > 10)
          return `Variant "${vName}": Unit cannot exceed 10 characters.`;
        const unitKey = unit.toLowerCase();
        if (usedUnits.includes(unitKey))
          return `Variant "${vName}": Duplicate suffix unit "${unit}".`;
        usedUnits.push(unitKey);
        const values = Array.isArray(s.values)
          ? s.values.map(x => (x || "").trim()).filter(Boolean)
          : [];
        if (values.length === 0)
          return `Variant "${vName}" (${unit}): At least one value is required.`;
        const seenVals = [];
        for (const val of values) {
          if (!/^[0-9]+$/.test(val))
            return `Variant "${vName}" (${unit}): Values must be numbers only. Got "${val}".`;
          if (val.length > 10)
            return `Variant "${vName}" (${unit}): Value "${val}" is too long.`;
          if (seenVals.includes(val))
            return `Variant "${vName}" (${unit}): Duplicate value "${val}".`;
          seenVals.push(val);
        }
      }
    }
  }
  return null;
}

function cleanSpecs(specificationsConfig) {
  return (Array.isArray(specificationsConfig) ? specificationsConfig : []).map(s => ({
    name:     s.name.trim(),
    required: !!s.required,
  }));
}

function cleanVariants(variantOptions) {
  return (Array.isArray(variantOptions) ? variantOptions : []).map(v => {
    const usesSuffix = v.usesSuffix === true || v.usesSuffix === "true";
    if (!usesSuffix) {
      return {
        variantName:  v.variantName.trim(),
        usesSuffix:   false,
        plainValues:  (Array.isArray(v.plainValues) ? v.plainValues : [])
                        .map(x => (x || "").trim()).filter(Boolean),
        suffixes:     [],
      };
    }
    return {
      variantName:  v.variantName.trim(),
      usesSuffix:   true,
      plainValues:  [],
      suffixes: (Array.isArray(v.suffixes) ? v.suffixes : []).map(s => ({
        unit:   (s.unit || "").trim().toUpperCase(),
        values: (Array.isArray(s.values) ? s.values : [])
                  .map(x => (x || "").trim()).filter(Boolean),
      })),
    };
  });
}

export const createCategory = async (req, res) => {
  try {
    let { categoryName, description, isActive, specificationsConfig, variantOptions } = req.body;

    if (typeof specificationsConfig === 'string') specificationsConfig = JSON.parse(specificationsConfig);
    if (typeof variantOptions === 'string') variantOptions = JSON.parse(variantOptions);

    const error = validateCategoryBody({ categoryName, specificationsConfig, variantOptions });
    if (error) return res.status(400).json({ success: false, message: error });

    const exists = await Category.findOne({
      categoryName: { $regex: `^${categoryName.trim()}$`, $options: "i" },
      isDeleted: false,
    });
    if (exists)
      return res.status(409).json({ success: false, message: "Category already exists." });

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Category image is required." });
    }
    const imagePath = `/uploads/category/${req.file.filename}`;

    const category = await Category.create({
      categoryName:         categoryName.trim(),
      description:          (description || "").trim(),
      image:                imagePath,
      isActive:             isActive === true || isActive === "true",
      isDeleted:            false,
      specificationsConfig: cleanSpecs(specificationsConfig),
      variantOptions:       cleanVariants(variantOptions),
    });

    res.status(201).json({ success: true, message: "Category created successfully.", category });
  } catch (err) {
    console.error("createCategory:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getCategoryById = async (req, res) => {
  try {
    const category = await Category.findOne({ _id: req.params.id, isDeleted: false }).lean();
    if (!category)
      return res.status(404).json({ success: false, message: "Category not found." });
    res.json({ success: true, category });
  } catch (err) {
    console.error("getCategoryById:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const updateCategory = async (req, res) => {
  try {
    let { categoryName, description, isActive, specificationsConfig, variantOptions } = req.body;

    if (typeof specificationsConfig === 'string') specificationsConfig = JSON.parse(specificationsConfig);
    if (typeof variantOptions === 'string') variantOptions = JSON.parse(variantOptions);

    const error = validateCategoryBody({ categoryName, specificationsConfig, variantOptions });
    if (error) return res.status(400).json({ success: false, message: error });

    const duplicate = await Category.findOne({
      _id:          { $ne: req.params.id },
      categoryName: { $regex: `^${categoryName.trim()}$`, $options: "i" },
      isDeleted:    false,
    });
    if (duplicate)
      return res.status(409).json({ success: false, message: "Another category with this name already exists." });

    const category = await Category.findOne({ _id: req.params.id, isDeleted: false });
    if (!category)
      return res.status(404).json({ success: false, message: "Category not found." });

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
      category.image = `/uploads/category/${req.file.filename}`;
    } else if (imageRemoved) {
      category.image = "";
    }
    category.isActive             = isActive === true || isActive === "true";
    category.specificationsConfig = cleanSpecs(specificationsConfig);
    category.variantOptions       = cleanVariants(variantOptions);

    await category.save();
    res.json({ success: true, message: "Category updated successfully.", category });
  } catch (err) {
    console.error("updateCategory:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const toggleCategoryStatus = async (req, res) => {
  try {
    const category = await Category.findOne({ _id: req.params.id, isDeleted: false });
    if (!category)
      return res.status(404).json({ success: false, message: "Category not found." });

    category.isActive = !category.isActive;
    await category.save();

    res.json({
      success:  true,
      message:  `Category ${category.isActive ? "activated" : "deactivated"}.`,
      isActive: category.isActive,
    });
  } catch (err) {
    console.error("toggleCategoryStatus:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const deleteCategory = async (req, res) => {
  try {
    const category = await Category.findOne({ _id: req.params.id, isDeleted: false });
    if (!category)
      return res.status(404).json({ success: false, message: "Category not found." });

    category.isDeleted = true;
    category.isActive  = false;
    await category.save();

    res.json({ success: true, message: "Category deleted successfully." });
  } catch (err) {
    console.error("deleteCategory:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};