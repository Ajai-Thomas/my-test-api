const express = require('express');
const app = express();
app.use(express.json());

// 1. High Risk Endpoint (Auth/Login)
// Project-J will flag this because of the word "login" and POST method.
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    res.json({ token: "fake-jwt-token" });
});

// 2. Medium Risk Endpoint (Data retrieval)
// Project-J will flag this as business-critical because it contains "users".
app.get('/api/users', (req, res) => {
    res.json([{ id: 1, name: "Ajai" }, { id: 2, name: "TestUser" }]);
});

// 3. Low Risk Endpoint (Health Check)
// Project-J will flag this as low risk/static because of the word "health".
app.get('/health', (req, res) => {
    res.status(200).send("OK");
});

app.listen(3000, () => console.log('Test app running on port 3000'));