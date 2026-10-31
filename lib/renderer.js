'use strict';

const path = require('path');

const createComponents = require('./renderer/components');

const NEW_SITE_ROUTE = '/main/bluehost-pull';

module.exports = function BluehostConnectRenderer(context) {
	const { React, ReactRouter, hooks } = context;
	const h = React.createElement;
	const { BluehostPanel, HeaderButtons, NewSitePage } = createComponents(context);

	hooks.addContent('stylesheets', () => h('link', {
		key: 'bluehost-connect-styles',
		rel: 'stylesheet',
		href: path.join(__dirname, 'renderer', 'styles.css'),
	}));

	// A "Bluehost" entry under the site's Tools tab: account connection, linking, and push/pull options.
	hooks.addFilter('siteInfoToolsItem', (items, { routeChildrenProps } = {}) => [
		...items,
		{
			path: '/bluehost-connect',
			menuItem: 'Bluehost',
			render: () => h(BluehostPanel, {
				site: routeChildrenProps && routeChildrenProps.site,
				siteStatus: routeChildrenProps && routeChildrenProps.siteStatus,
			}),
		},
	]);

	// "Bluehost: Pull / Push" buttons in the site header, next to Local Connect's own push/pull buttons.
	hooks.addContent('SiteInfo_Top_TopRight', (site, siteStatus) => h(HeaderButtons, {
		key: 'bluehost-connect-buttons',
		site,
		siteStatus,
	}));

	// "Pull from Bluehost" in Local's Create a site wizard. The option key is the route Continue navigates to.
	hooks.addFilter('CreateSite:RadioOptions', (options) => ({
		...options,
		[NEW_SITE_ROUTE.replace(/^\/main\//, '')]: {
			label: 'Pull from Bluehost',
			content: 'Create a new Local site from a Bluehost WordPress site, files and database.',
		},
	}));

	hooks.addContent('routes[main]', () => h(ReactRouter.Route, {
		key: 'bluehost-connect-new-site',
		path: NEW_SITE_ROUTE,
		render: ({ history }) => h(NewSitePage, { history }),
	}));
};
