#!/usr/bin/env python3
"""
Run the web application.
"""

import sys
import os

# Add current directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Run the web app
from web_app.app import app

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
