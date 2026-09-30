const mongoose = require('mongoose');
require('dotenv').config();
const Category = require('./models/category');
const MenuItem = require('./models/menuItem');

const mongoUrl = process.env.MONGO_URL;

const checkDB = async () => {
    try {
        await mongoose.connect(mongoUrl);
        const cats = await Category.find({});
        for (const cat of cats) {
            const itemCount = await MenuItem.countDocuments({ category: cat._id });
            const activeItemCount = await MenuItem.countDocuments({ category: cat._id, status: 'active' });
            console.log(`Category: ${cat.name} (id: ${cat._id}) - Total: ${itemCount}, Active: ${activeItemCount}`);
        }
        mongoose.connection.close();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

checkDB();
