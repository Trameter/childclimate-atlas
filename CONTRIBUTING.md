# Contributing to ChildClimate Risk Atlas

Thank you for your interest in improving children's climate resilience worldwide.

## Quick start

```bash
git clone https://github.com/Trameter/childclimate-atlas.git
cd childclimate-atlas
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 -m pipeline.build --country NGA --limit 20   # quick test
cd web && python3 serve.py                             # view the map
```

## Ways to contribute

### Add a new country
1. Copy `config/NGA.yaml` to `config/{ISO3}.yaml`
2. Set the correct bounding box, focus region, and scoring weights
3. Run the pipeline and verify results
4. Submit a PR with the new config + any tuning notes

### Improve the scoring model
- All scoring logic is in `pipeline/scoring/score.py`
- Threshold curves are based on WHO/IPCC guidelines — cite your sources if changing
- Add new sub-score components by following the existing pattern

### Add a data source
- Create a new module in `pipeline/sources/`
- Follow the pattern in `climate.py`: fetch + summarize per facility
- Wire it into `pipeline/build.py` and `scoring/score.py`

### Improve the frontend
- Everything is in `web/` — static HTML + CSS + vanilla JS
- No build step, no npm, no frameworks
- Test in multiple browsers before submitting

## Code style
- Python: follow PEP 8, type hints encouraged
- JavaScript: vanilla ES6+, no transpilation needed
- Keep dependencies minimal — every new dependency is a barrier for ministry IT teams

## Commit messages
- Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Reference issue numbers where applicable

## License
By contributing, you agree that your contributions will be licensed under MIT.
