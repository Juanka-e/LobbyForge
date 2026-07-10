import os

search_dir = "d:\\livekittest"
pattern = "UserRole"

for root, dirs, files in os.walk(search_dir):
    if ".git" in root or "node_modules" in root or ".agents" in root:
        continue
    for file in files:
        if file.endswith((".ts", ".tsx", ".json", ".md")):
            path = os.path.join(root, file)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    content = f.read()
                    if pattern in content:
                        print(f"Found in {path}")
            except Exception:
                pass
