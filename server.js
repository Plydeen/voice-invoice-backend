require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
// Swapped to 5001 to bypass macOS conflicts
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'Voice Invoice API — alive' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
