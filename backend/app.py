import os
from flask import Flask
from flask_cors import CORS
from routes.upload import upload_bp
from routes.statsbomb import statsbomb_bp
from routes.clips import clips_bp
from routes.video import video_bp
from routes.external import external_bp
from routes.footballia import footballia_bp

app = Flask(__name__)

# The single allowed CORS origin is the Vercel frontend's URL, set via the
# FRONTEND_URL env var so the domain is never hardcoded. Falls back to the
# local Vite dev server when unset.
_frontend_url = os.environ.get("FRONTEND_URL", "http://localhost:3000")
CORS(app, resources={r"/api/*": {"origins": _frontend_url}})

# Anchor storage folders to the backend directory so path resolution doesn't
# depend on the process working directory (Flask's send_file resolves relative
# paths against app.root_path, while os/ffmpeg use the CWD).
app.config["UPLOAD_FOLDER"] = os.path.join(app.root_path, "uploads")
app.config["CLIPS_FOLDER"] = os.path.join(app.root_path, "clips")
app.config["EXTERNAL_FOLDER"] = os.path.join(app.root_path, "external")
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024  # 2 GB

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["CLIPS_FOLDER"], exist_ok=True)
os.makedirs(app.config["EXTERNAL_FOLDER"], exist_ok=True)

app.register_blueprint(upload_bp, url_prefix="/api")
app.register_blueprint(statsbomb_bp, url_prefix="/api")
app.register_blueprint(clips_bp, url_prefix="/api")
app.register_blueprint(video_bp, url_prefix="/api")
app.register_blueprint(external_bp, url_prefix="/api")
app.register_blueprint(footballia_bp, url_prefix="/api")

if __name__ == "__main__":
    # use_reloader=False prevents the watchdog from watching site-packages
    # (torch/easyocr installs trigger constant restarts otherwise)
    app.run(debug=True, port=5000, use_reloader=False)
