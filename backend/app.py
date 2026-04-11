import os
from flask import Flask
from flask_cors import CORS
from routes.upload import upload_bp
from routes.statsbomb import statsbomb_bp
from routes.clips import clips_bp
from routes.video import video_bp

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "http://localhost:3000"}})

app.config["UPLOAD_FOLDER"] = "uploads"
app.config["CLIPS_FOLDER"] = "clips"
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024  # 2 GB

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["CLIPS_FOLDER"], exist_ok=True)

app.register_blueprint(upload_bp, url_prefix="/api")
app.register_blueprint(statsbomb_bp, url_prefix="/api")
app.register_blueprint(clips_bp, url_prefix="/api")
app.register_blueprint(video_bp, url_prefix="/api")

if __name__ == "__main__":
    # use_reloader=False prevents the watchdog from watching site-packages
    # (torch/easyocr installs trigger constant restarts otherwise)
    app.run(debug=True, port=5000, use_reloader=False)
