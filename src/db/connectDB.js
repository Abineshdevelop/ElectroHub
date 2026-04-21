import mongoose from "mongoose"
export async function connectDB(){
    try{
        console.log(process.env.MONGO_URI )
        const monogUri = process.env.MONGO_URI 
        if(!monogUri) throw new Error("Mongo Uri not found")
        const connection=await mongoose.connect(process.env.MONGO_URI,{})
        console.log("mongodb connected")
    } catch(error){
        console.log("MongoDB connection error",error)
        process.exit(1);  //0 normal 1 means exit the mongodb url
    }
}

