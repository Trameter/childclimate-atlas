#!/usr/bin/env python3
"""Tiny static file server for the ChildClimate Atlas web UI.

Serves the directory this script lives in. Run with:  python3 web/serve.py
"""
import http.server
import os
import socketserver
import sys

PORT = int(os.environ.get("PORT", "8787"))
HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # No caching so data changes show up immediately.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[atlas-web] " + fmt % args + "\n")


with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"[atlas-web] serving {HERE} at http://127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()
