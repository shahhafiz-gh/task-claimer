const firebaseConfig = {
  apiKey: "AIzaSyD6XJ6g8M5X-aczWcBPxx9aO2-itF6VYss",
  authDomain: "rip-et.firebaseapp.com",
  projectId: "rip-et",
  storageBucket: "rip-et.firebasestorage.app",
  messagingSenderId: "1040676980791",
  appId: "1:1040676980791:web:809adb603cd254c72b97b2",
  measurementId: "G-R07N9N74QB"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

const provider = new firebase.auth.GoogleAuthProvider();

auth.getRedirectResult().then((result) => {
  if (result && result.user) {
    console.log("Redirect login successful");
    window.close(); // Close tab on success!
  } else {
    // If no result, initiate the redirect!
    auth.signInWithRedirect(provider);
  }
}).catch((error) => {
  document.body.innerHTML = `<h3>Error logging in with Google</h3><p>${error.message}</p>`;
  console.error(error);
});
