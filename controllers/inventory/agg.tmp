// Thin aggregator: handlers live in controllers/inventory/*. Every name this
// module exported before the split is re-exported here, in the same order, so
// routes, services and tests that require this file keep working unchanged.
const items = require('./inventory/items');
const stock = require('./inventory/stock');
const itemsCsv = require('./inventory/itemsCsv');
const recipes = require('./inventory/recipes');
const recipesCsv = require('./inventory/recipesCsv');
const reports = require('./inventory/reports');
const deduction = require('./inventory/deduction');

module.exports = {
    getAllItems: items.getAllItems,
    getSummary: stock.getSummary,
    getAlerts: stock.getAlerts,
    getNextId: items.getNextId,
    getItemById: items.getItemById,
    createItem: items.createItem,
    downloadInventoryTemplate: itemsCsv.downloadInventoryTemplate,
    importItemsCsv: itemsCsv.importItemsCsv,
    updateItem: items.updateItem,
    adjustStock: stock.adjustStock,
    deleteItem: items.deleteItem,
    getRecipes: recipes.getRecipes,
    getRecipeByMenuItem: recipes.getRecipeByMenuItem,
    saveRecipe: recipes.saveRecipe,
    downloadRecipesTemplate: recipesCsv.downloadRecipesTemplate,
    importRecipesCsv: recipesCsv.importRecipesCsv,
    deleteRecipe: recipes.deleteRecipe,
    getFoodCostReport: reports.getFoodCostReport,
    getMenuItemIssues: reports.getMenuItemIssues,
    checkInventoryForOrder: deduction.checkInventoryForOrder,
    deductInventoryForOrder: deduction.deductInventoryForOrder,
    restoreInventoryForOrder: deduction.restoreInventoryForOrder,
    getActualVsTheoretical: reports.getActualVsTheoretical,
    getStockReport: reports.getStockReport,
    getConsumptionReport: reports.getConsumptionReport,
};
