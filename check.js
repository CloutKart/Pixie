require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listMyModels() {
  console.log("Fetching available models...");
  try {
    // We use the raw REST API endpoint here to just fetch the list
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
    const data = await response.json();
    
    console.log("--- MODELS AVAILABLE TO YOUR KEY ---");
    data.models.forEach(model => {
        // Only print models that support text generation
        if (model.supportedGenerationMethods.includes("generateContent")) {
            console.log(model.name.replace('models/', ''));
        }
    });
  } catch (error) {
    console.error("Error fetching models:", error);
  }
}

listMyModels();
