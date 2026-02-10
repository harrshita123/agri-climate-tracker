document.getElementById("continueBtn").addEventListener("click", () => {
  const value = document.getElementById("locationInput").value;
  alert("Entered location: " + value);
});

document.getElementById("currentLocationBtn").addEventListener("click", () => {
  alert("Fetching current location...");
});
