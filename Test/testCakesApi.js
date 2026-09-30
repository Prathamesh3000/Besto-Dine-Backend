async function testFetch() {
    try {
        const res = await fetch('http://localhost:5000/api/booking-info/cakes');
        const data = await res.json();
        console.log('API Result (Cakes):', JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('API Error:', err.message);
    }
}

testFetch();
