import plotly.graph_objects as go

fig = go.Figure(
    go.Scattermap(
        mode="lines",
        fill="toself",
        lon=[
            -10,
            -10,
            8,
            8,
            -10,
            None,
            30,
            30,
            50,
            50,
            30,
            None,
            100,
            100,
            80,
            80,
            100,
        ],
        lat=[30, 6, 6, 30, 30, None, 20, 30, 30, 20, 20, None, 40, 50, 50, 40, 40],
    )
)

fig.update_layout(
    map={"style": "open-street-map", "center": {"lon": 30, "lat": 30}, "zoom": 2},
    showlegend=False,
    margin={"l": 0, "r": 0, "b": 0, "t": 0},
)

fig.show()
